<?php

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

// Manage proxy accounts (the basic_auth lines that end up in the
// Caddyfile). On create/regen we show the cleartext password ONCE in
// a notification — it's never persisted.

class ProxyAccountResource extends Resource
{
    protected static ?string $model = ProxyAccount::class;
    protected static ?string $navigationIcon = 'heroicon-o-user-group';
    protected static ?string $navigationLabel = 'Proxy accounts';
    protected static ?int $navigationSort = 10;

    public static function form(Form $form): Form
    {
        return $form->schema([
            Forms\Components\TextInput::make('username')
                ->required()
                ->alphaDash()
                ->maxLength(64)
                ->unique(ignoreRecord: true)
                ->helperText('ASCII letters, digits, dashes, underscores. The client will use this as basic-auth username.'),

            Forms\Components\TextInput::make('label')
                ->maxLength(255)
                ->helperText('Free-form note — who is this account for?'),

            Forms\Components\Toggle::make('enabled')
                ->default(true),

            Forms\Components\TextInput::make('quota_bytes')
                ->numeric()
                ->minValue(0)
                ->suffix('bytes')
                ->helperText('Leave blank for unlimited. 1 GiB = 1073741824.'),

            Forms\Components\DateTimePicker::make('expires_at')
                ->helperText('Leave blank to never expire.')
                ->seconds(false),

            Forms\Components\Placeholder::make('password_note')
                ->label('Password')
                ->content('A new random password is generated when you create this account; the cleartext is shown once and not stored. Use the "Regenerate password" action to issue a new one later.')
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
                Tables\Columns\TextColumn::make('last_seen_at')->dateTime()->since()->placeholder('never')->sortable(),
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
                        $record->password_hash = $pw['hash'];
                        $record->save();
                        Notification::make()
                            ->title('New password — copy now, shown once')
                            ->body($pw['cleartext'])
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
            'index'  => Pages\ListProxyAccounts::route('/'),
            'create' => Pages\CreateProxyAccount::route('/create'),
            'edit'   => Pages\EditProxyAccount::route('/{record}/edit'),
        ];
    }

    private static function humanBytes(?int $bytes): string
    {
        if (! $bytes) return '0 B';
        $units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
        $i = (int) floor(log($bytes, 1024));
        $i = max(0, min($i, count($units) - 1));
        return round($bytes / (1024 ** $i), 2).' '.$units[$i];
    }
}
