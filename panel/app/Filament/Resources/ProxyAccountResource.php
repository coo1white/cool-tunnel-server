<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Resources;

use App\Filament\Resources\ProxyAccountResource\Pages;
use App\Models\ProxyAccount;
use App\Services\PasswordGenerator;
use Filament\Forms;
use Filament\Forms\Form;
use Filament\Notifications\Notification;
use Filament\Resources\Resource;
use Filament\Tables;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

// Manage proxy accounts (the {username, password} entries that end
// up in sing-box's naive inbound `users` array). On create / regen
// we show the cleartext ONCE in a notification; the cleartext is
// also persisted encrypted (Laravel Crypt → AES-256-GCM) so
// ct-server-core can render it into the sing-box config without
// needing to ask the operator again.

class ProxyAccountResource extends Resource
{
    protected static ?string $model = ProxyAccount::class;

    protected static ?string $navigationIcon = 'heroicon-o-user-group';

    protected static ?string $navigationLabel = 'Proxy accounts';

    protected static ?string $navigationGroup = 'Users';

    protected static ?int $navigationSort = 10;

    public static function form(Form $form): Form
    {
        return $form->schema([
            Forms\Components\Section::make('Identity')
                ->description('How the client authenticates to sing-box.')
                ->schema([
                    Forms\Components\TextInput::make('username')
                        ->required()
                        ->alphaDash()
                        ->maxLength(64)
                        ->unique(ignoreRecord: true)
                        ->autocomplete('off')
                        ->helperText('ASCII letters, digits, dashes, underscores. The client will use this as basic-auth username.'),

                    Forms\Components\TextInput::make('label')
                        ->maxLength(255)
                        ->helperText('Free-form note — who is this account for?'),

                    Forms\Components\Toggle::make('enabled')
                        ->default(true)
                        ->helperText('Disable to revoke access without deleting history. Push to sing-box happens within ~100 ms via the Redis revocation bus.'),
                ])->columns(2),

            Forms\Components\Section::make('Limits')
                ->description('Optional — leave blank for an unmetered, never-expiring account.')
                ->schema([
                    Forms\Components\TextInput::make('quota_bytes')
                        ->label('Monthly quota')
                        ->numeric()
                        ->minValue(0)
                        ->suffix('bytes')
                        ->helperText('Leave blank for unlimited. 1 GiB = 1073741824. Quota enforcement runs once per minute via the scheduler.'),

                    Forms\Components\DateTimePicker::make('expires_at')
                        ->helperText('Leave blank to never expire. Past dates immediately disable the account.')
                        ->seconds(false)
                        ->minDate(now()),
                ])->columns(2),

            Forms\Components\Placeholder::make('password_note')
                ->label('Password')
                ->content('A new random password is generated when you create this account; the cleartext is shown once and not stored in any log. Use the "Regenerate password" action to issue a new one later.')
                ->visibleOn('create'),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                Tables\Columns\TextColumn::make('username')->searchable()->sortable(),
                Tables\Columns\TextColumn::make('label')->searchable()->limit(40)->toggleable(),
                Tables\Columns\IconColumn::make('enabled')->boolean(),
                Tables\Columns\TextColumn::make('used_bytes')
                    ->label('Used')
                    ->formatStateUsing(fn ($state) => self::humanBytes($state)),
                Tables\Columns\TextColumn::make('quota_bytes')
                    ->label('Quota')
                    ->formatStateUsing(fn ($state) => $state ? self::humanBytes($state) : '—'),
                Tables\Columns\TextColumn::make('expires_at')->dateTime()->placeholder('—')->sortable(),
                // last_seen_at is written by metrics::collect, which is a
                // no-op until sing-box exposes per-user Prometheus
                // counters (see metrics.rs module docstring). Hidden
                // by default to avoid showing a column that's always
                // 'never' in current deployments — toggleable for
                // operators inspecting historical rows or running on
                // a future build with traffic plumbing wired.
                Tables\Columns\TextColumn::make('last_seen_at')
                    ->dateTime()
                    ->since()
                    ->placeholder('never')
                    ->sortable()
                    ->toggleable(isToggledHiddenByDefault: true),
            ])
            ->filters([
                Tables\Filters\TernaryFilter::make('enabled'),
            ])
            ->actions([
                Tables\Actions\EditAction::make(),
                Tables\Actions\Action::make('regenerate_password')
                    ->label('Regenerate password')
                    ->icon('heroicon-o-key')
                    ->color('warning')
                    ->requiresConfirmation()
                    ->action(function (ProxyAccount $record) {
                        $pw = PasswordGenerator::make();
                        $record->setCleartextPassword($pw['cleartext']);
                        $record->save();

                        $subUrl = $record->subscriptionUrl();
                        $body = $pw['cleartext'];
                        if ($subUrl !== null) {
                            $body .= "\n\nSubscription URL (import in the app):\n{$subUrl}";
                        }

                        Notification::make()
                            ->title('New password — copy now, shown once')
                            ->body($body)
                            ->success()
                            ->persistent()
                            ->send();
                    }),
                Tables\Actions\Action::make('show_subscription_url')
                    ->label('Subscription URL')
                    ->icon('heroicon-o-link')
                    ->color('info')
                    ->action(function (ProxyAccount $record) {
                        $url = $record->subscriptionUrl();
                        if ($url === null) {
                            Notification::make()
                                ->title('Cannot generate URL')
                                ->body('APP_KEY is not configured. Run php artisan key:generate and restart the panel.')
                                ->danger()
                                ->send();

                            return;
                        }
                        Notification::make()
                            ->title('Subscription URL — import in the app')
                            ->body($url)
                            ->success()
                            ->persistent()
                            ->send();
                    }),
                Tables\Actions\DeleteAction::make(),
            ])
            ->bulkActions([
                Tables\Actions\DeleteBulkAction::make(),
            ])
            ->defaultSort('created_at', 'desc');
    }

    public static function getEloquentQuery(): Builder
    {
        return parent::getEloquentQuery();
    }

    public static function getPages(): array
    {
        return [
            'index' => Pages\ListProxyAccounts::route('/'),
            'create' => Pages\CreateProxyAccount::route('/create'),
            'edit' => Pages\EditProxyAccount::route('/{record}/edit'),
        ];
    }

    private static function humanBytes(?int $bytes): string
    {
        if (! $bytes) {
            return '0 B';
        }
        $units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        $i = (int) floor(log($bytes, 1024));
        $i = max(0, min($i, count($units) - 1));

        return round($bytes / (1024 ** $i), 2).' '.$units[$i];
    }
}
