<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Resources;

use App\Filament\Resources\ProxyAccountResource\Pages;
use App\Models\ProxyAccount;
use App\Support\SingBoxProtocolCatalog;
use App\Support\SingBoxRenderConfirmation;
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
                ->schema([
                    Forms\Components\TextInput::make('username')
                        ->required()
                        ->alphaDash()
                        ->maxLength(64)
                        ->unique(ignoreRecord: true)
                        ->autocomplete('off')
                        ->helperText('Letters, digits, dashes, and underscores.'),

                    Forms\Components\TextInput::make('label')
                        ->maxLength(255)
                        ->helperText('Optional note.'),

                    Forms\Components\Toggle::make('enabled')
                        ->default(true)
                        ->helperText('Turn off to revoke access.'),
                ])->columns(2),

            Forms\Components\Section::make('Access window')
                ->schema([
                    // No `->minDate(now())` here — applying it on edit
                    // blocks the operator from saving an unmodified
                    // expired account (the existing past timestamp
                    // fails the rule), which means they can't change
                    // the label of an already-expired account
                    // without also re-issuing a future expires_at.
                    // The helperText documents the past-date behaviour;
                    // operator intent stands.
                    Forms\Components\DateTimePicker::make('expires_at')
                        ->helperText('Blank means never expires.')
                        ->seconds(false),
                ]),

            Forms\Components\Section::make('Client defaults')
                ->schema([
                    Forms\Components\TextInput::make('client_default_local_port')
                        ->label('Local SOCKS port')
                        ->integer()
                        ->default(1080)
                        ->minValue(1024)
                        ->maxValue(65535)
                        ->required()
                        ->helperText('Imported by new client profiles.'),
                ]),

            Forms\Components\Section::make('Protocol')
                ->schema([
                    Forms\Components\Placeholder::make('protocol_mode')
                        ->key('protocol_mode')
                        ->label('Mode')
                        ->content(fn (Forms\Get $get, string $operation): string => SingBoxProtocolCatalog::modeSummary(
                            $operation === 'create'
                                ? SingBoxProtocolCatalog::defaultKeys()
                                : $get('enabled_protocols'),
                            defaultWhenEmpty: $operation === 'create',
                        )),
                ]),

            Forms\Components\Placeholder::make('uuid_note')
                ->label('UUID')
                ->content('A fresh UUID is generated on create and shown once.')
                ->visibleOn('create'),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                Tables\Columns\TextColumn::make('username')
                    ->searchable()
                    ->sortable()
                    ->description(fn (ProxyAccount $record): ?string => $record->label),
                Tables\Columns\TextColumn::make('protocol_mode')
                    ->label('Mode')
                    ->getStateUsing(fn (ProxyAccount $record): string => SingBoxProtocolCatalog::modeSummary(
                        $record->enabledProtocolKeys(),
                        defaultWhenEmpty: false,
                    ))
                    ->wrap(),
                Tables\Columns\IconColumn::make('enabled')->boolean(),
                Tables\Columns\TextColumn::make('expires_at')
                    ->label('Expires')
                    ->dateTime()
                    ->placeholder('Never')
                    ->sortable(),
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
                        $renderConfirmed = SingBoxRenderConfirmation::renderNow('proxy_account.regenerate_uuid');

                        $subUrl = $record->subscriptionUrl();
                        $body = $uuid;
                        if ($subUrl !== null) {
                            $body .= "\n\nSubscription URL (import in the app):\n{$subUrl}";
                        }
                        $body .= $renderConfirmed
                            ? "\n\nsing-box config rendered now; the URL is ready to import."
                            : "\n\nReload queued, but immediate render was not confirmed. If import fails, wait a few seconds and retry, then check panel logs for singbox.render.*.";

                        $notification = Notification::make()
                            ->title($renderConfirmed ? 'New UUID — URL ready' : 'New UUID — reload queued')
                            ->body($body)
                            ->persistent();

                        if ($renderConfirmed) {
                            $notification->success();
                        } else {
                            $notification->warning();
                        }
                        $notification->send();

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
                Tables\Actions\DeleteAction::make()
                    ->successNotification(null)
                    ->after(fn () => self::sendRenderNotification('Proxy account deleted', 'proxy_account.delete')),
            ])
            ->bulkActions([
                Tables\Actions\DeleteBulkAction::make()
                    ->successNotification(null)
                    ->after(fn () => self::sendRenderNotification('Proxy accounts deleted', 'proxy_account.bulk_delete')),
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

    private static function sendRenderNotification(string $title, string $context): void
    {
        $renderConfirmed = SingBoxRenderConfirmation::renderNow($context);

        $notification = Notification::make()
            ->title($renderConfirmed ? "{$title} — config current" : "{$title} — reload queued")
            ->body($renderConfirmed
                ? 'sing-box config rendered now; client imports use the current account state.'
                : 'The DB row was saved, but immediate render was not confirmed. The worker or every-5-min scheduler will reconcile sing-box; check panel logs for singbox.render.* if the client state still looks stale.')
            ->persistent();

        if ($renderConfirmed) {
            $notification->success();
        } else {
            $notification->warning();
        }

        $notification->send();
    }
}
