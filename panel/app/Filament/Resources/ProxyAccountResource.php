<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Resources;

use App\Filament\Resources\ProxyAccountResource\Pages;
use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use App\Support\RealityDestinations;
use App\Support\SingBoxProtocolCatalog;
use Filament\Forms\Get;
use Filament\Forms;
use Filament\Forms\Form;
use Filament\Notifications\Actions\Action;
use Filament\Notifications\Notification;
use Filament\Resources\Resource;
use Filament\Tables;
use Filament\Tables\Table;
use Illuminate\Database\Eloquent\Builder;

// Manage proxy accounts (the {name, uuid} entries that end up in
// sing-box's `vless` inbound users[] array under VLESS+Reality).
// On create / regen we show the UUID ONCE in a notification; the UUID
// IS the credential — like an API key — and is persisted in plain
// text. There is no "show existing UUID" path by design; lose it,
// regenerate.

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
                        ->helperText('ASCII letters, digits, dashes, underscores. Used as the VLESS user `name` for log readability; the per-account credential is the UUID assigned at create / regen.'),

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

                    // No `->minDate(now())` here — applying it on edit
                    // blocks the operator from saving an unmodified
                    // expired account (the existing past timestamp
                    // fails the rule), which means they can't change
                    // the label / quota of an already-expired account
                    // without also re-issuing a future expires_at.
                    // The helperText documents the past-date behaviour;
                    // operator intent stands.
                    Forms\Components\DateTimePicker::make('expires_at')
                        ->helperText('Leave blank to never expire. Past dates immediately disable the account.')
                        ->seconds(false),
                ])->columns(2),

            Forms\Components\Section::make('Client defaults')
                ->description('Values imported by new client profiles from this account subscription URL.')
                ->schema([
                    Forms\Components\TextInput::make('client_default_local_port')
                        ->label('Local SOCKS port')
                        ->integer()
                        ->default(1080)
                        ->minValue(1024)
                        ->maxValue(65535)
                        ->required()
                        ->helperText('The macOS app binds sing-box on 127.0.0.1 at this port for newly imported profiles. Existing client-local edits are preserved by older app builds.'),
                ]),

            Forms\Components\Section::make('Protocols')
                ->description('Select the sing-box protocol set signed into this account subscription.')
                ->schema([
                    Forms\Components\CheckboxList::make('enabled_protocols')
                        ->label('sing-box protocol choices')
                        ->options(fn (Get $get): array => SingBoxProtocolCatalog::options(
                            ServerConfig::current(),
                            (string) ($get('reality_dest_host') ?? ''),
                            measureLatency: true,
                        ))
                        ->default(SingBoxProtocolCatalog::defaultKeys())
                        ->required()
                        ->columns(2)
                        ->bulkToggleable()
                        ->dehydrateStateUsing(
                            fn ($state): array => SingBoxProtocolCatalog::normaliseSelected($state)
                        )
                        ->helperText('VLESS + Reality is rendered today and keeps the generated URL directly usable. Other sing-box protocols are saved into the subscription as a staged catalog so server and client can expand together without drift.'),
                ]),

            Forms\Components\Section::make('Reality destination')
                ->description('Server-wide cover website VLESS+Reality mimics; changing it affects every subscription manifest and the rendered sing-box config.')
                ->schema([
                    Forms\Components\Select::make('reality_dest_host')
                        ->label('Website')
                        ->options(fn (): array => RealityDestinations::options(
                            (string) (ServerConfig::current()->reality_dest_host ?? ''),
                            measureLatency: true,
                        ))
                        ->default(fn (): string => RealityDestinations::selectDefault(
                            (string) (ServerConfig::current()->reality_dest_host ?? ''),
                        ))
                        ->required()
                        ->live()
                        ->searchable()
                        ->native(false)
                        ->helperText('The selected value is signed into the generated subscription manifest. Use this only when you intend to rotate the server-wide Reality destination.'),
                ])
                ->visibleOn('create'),

            Forms\Components\Placeholder::make('uuid_note')
                ->label('UUID')
                ->content('A fresh VLESS UUID is generated when you create this account; it is shown once and not stored in any log. Use the "Regenerate UUID" action to rotate it later — the old UUID stops authenticating the moment sing-box reloads.')
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
                Tables\Actions\Action::make('regenerate_uuid')
                    ->label('Regenerate UUID')
                    ->icon('heroicon-o-key')
                    ->color('warning')
                    ->requiresConfirmation()
                    // Defense-in-depth: the Filament panel sits behind
                    // its own auth middleware so unauthenticated callers
                    // never reach this Livewire action under normal
                    // routing. The explicit closure exists as a
                    // belt-and-braces guard for the case where a future
                    // refactor exposes the Livewire component via a
                    // different route, or a future multi-tenant
                    // ProxyAccountPolicy adds a per-record scope. Today
                    // single-admin makes every authenticated user the
                    // admin, so a simple auth-check is sufficient.
                    ->authorize(fn (): bool => auth()->check())
                    ->action(function (ProxyAccount $record) {
                        $uuid = $record->regenerateUuid();
                        $record->save();

                        $subUrl = $record->subscriptionUrl();
                        $body = $uuid;
                        if ($subUrl !== null) {
                            $body .= "\n\nSubscription URL (import in the app):\n{$subUrl}";
                        }

                        Notification::make()
                            ->title('New UUID — copy now, shown once')
                            ->body($body)
                            ->success()
                            ->persistent()
                            ->send();

                        // Follow-up warning when APP_KEY is unset — the
                        // UUID rotated fine but the subscription URL
                        // silently dropped out of the success body.
                        // Same diagnostic copy as `show_subscription_url`
                        // keeps the recovery path consistent across
                        // both actions.
                        if ($subUrl === null) {
                            Notification::make()
                                ->title('Subscription URL not generated')
                                ->body('APP_KEY is not configured. Run php artisan key:generate and restart the panel to enable subscription URLs.')
                                ->warning()
                                ->persistent()
                                ->send();
                        }
                    }),
                Tables\Actions\Action::make('show_subscription_url')
                    ->label('Subscription URL')
                    ->icon('heroicon-o-link')
                    ->color('info')
                    // Mirror the regenerate_password guard above. The
                    // generated URL embeds the per-account HMAC token —
                    // exposing it without authz would let an attacker
                    // who reaches this Livewire endpoint enumerate
                    // active subscription URLs.
                    ->authorize(fn (): bool => auth()->check())
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
                        // The "Copy URL" action wires an Alpine `x-on:click`
                        // that calls `navigator.clipboard.writeText()` with
                        // the URL safely JS-encoded via json_encode (handles
                        // quotes / unicode / line breaks). On secure
                        // contexts (HTTPS / localhost) this copies in one
                        // click. On non-secure contexts the API is
                        // unavailable and the click is a silent no-op —
                        // the URL stays visible in the notification body
                        // for manual selection, preserving the
                        // pre-v0.0.64 behaviour as a fallback.
                        $jsUrl = json_encode($url, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                        Notification::make()
                            ->title('Subscription URL — import in the app')
                            ->body($url)
                            ->success()
                            ->persistent()
                            ->actions([
                                Action::make('copy')
                                    ->label('Copy URL')
                                    ->icon('heroicon-o-clipboard')
                                    ->color('gray')
                                    ->extraAttributes([
                                        'x-on:click' => "navigator.clipboard?.writeText({$jsUrl})",
                                    ]),
                            ])
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
