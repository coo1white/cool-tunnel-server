<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Pages;

use App\Models\ServerConfig;
use App\Support\RealityDestinationCatalog;
use Filament\Actions\Action;
use Filament\Forms\Components\Placeholder;
use Filament\Forms\Components\Section;
use Filament\Forms\Components\Select;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Forms\Concerns\InteractsWithForms;
use Filament\Forms\Contracts\HasForms;
use Filament\Forms\Form;
use Filament\Forms\Get;
use Filament\Notifications\Notification;
use Filament\Pages\Concerns\InteractsWithFormActions;
use Filament\Pages\Page;
use Illuminate\Support\Facades\Redis;
use Throwable;

/**
 * @property Form $form Provided by InteractsWithForms (Filament magic).
 */
class ServerConfigPage extends Page implements HasForms
{
    use InteractsWithFormActions;
    use InteractsWithForms;

    protected static ?string $navigationIcon = 'heroicon-o-cog-6-tooth';

    protected static ?string $navigationLabel = 'Server config';

    protected static ?string $navigationGroup = 'System';

    protected static ?int $navigationSort = 90;

    protected static string $view = 'filament.pages.server-config';

    public ?array $data = [];

    public function mount(): void
    {
        $this->form->fill(ServerConfig::current()->toArray());
    }

    public function form(Form $form): Form
    {
        return $form
            ->schema([
                Section::make('Identity')
                    ->schema([
                        // Defense-in-depth: validate `domain` at the form
                        // layer in addition to the v0.0.16 render-layer
                        // `template::caddyfile_validate` guard. The render
                        // layer rejects metasyntactic chars (\n / { / } /
                        // ") with a clear error so the bad config never
                        // reaches Caddy — but a typo'd domain still
                        // persists in the DB and causes every render
                        // attempt to fail until the operator notices.
                        // The form regex below catches the typo at save
                        // time. RFC 1123 label / FQDN shape, max 253
                        // chars per RFC. (v0.0.21 — defense-in-depth.)
                        TextInput::make('domain')
                            ->required()
                            ->maxLength(253)
                            ->regex('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i')
                            ->validationMessages([
                                'regex' => 'Must be a valid FQDN (e.g. proxy.example.com) — no spaces, no `{` `}` `"`, no newlines.',
                            ]),
                        TextInput::make('acme_email')->required()->email(),
                        // `datalist` provides browser-native autocomplete
                        // suggestions for the two well-known Let's Encrypt
                        // endpoints while leaving the field free-text so
                        // operators with a private ACME (Step CA, Smallstep,
                        // self-hosted Boulder, etc.) can still paste their
                        // own URL. Pre-v0.0.64 this was bare TextInput;
                        // common typo surface — silent ACME failure on
                        // first cert renewal, ~2 months after install.
                        TextInput::make('acme_directory')
                            ->required()
                            ->url()
                            ->datalist([
                                'https://acme-v02.api.letsencrypt.org/directory',
                                'https://acme-staging-v02.api.letsencrypt.org/directory',
                            ])
                            ->helperText('Pick from the dropdown or paste a custom ACME URL. LE production issues real (rate-limited) certs; LE staging issues throwaway certs for testing.'),
                    ])->columns(3),

                Section::make('Reality')
                    ->schema([
                        Select::make('reality_dest_host')
                            ->label('Website')
                            ->options(fn (Get $get): array => RealityDestinationCatalog::selectOptions(
                                currentHost: (string) ($get('reality_dest_host') ?: (ServerConfig::current()->reality_dest_host ?? '')),
                                includeCachedLatency: true,
                            ))
                            ->default(fn (): string => RealityDestinationCatalog::selectDefault(
                                (string) (ServerConfig::current()->reality_dest_host ?? ''),
                            ))
                            ->required()
                            ->searchable()
                            ->native(false)
                            ->helperText('Global cover website used by every VLESS + Reality subscription. Account creation reads this value; it never mutates it.'),
                        Placeholder::make('reality_dest_latency')
                            ->label('Latency')
                            ->content(fn (Get $get): string => RealityDestinationCatalog::latencyStatusText(
                                (string) $get('reality_dest_host'),
                            )),
                    ]),

                Section::make('Anti-tracking')
                    ->description('Saving regenerates the Caddyfile and sing-box config; ct-singbox picks up file changes automatically.')
                    ->schema([
                        Toggle::make('anti_tracking_hide_ip')->label('hide_ip'),
                        Toggle::make('anti_tracking_hide_via')->label('hide_via'),
                        Toggle::make('anti_tracking_probe_resistance')->label('probe_resistance'),
                        TextInput::make('anti_tracking_doh_resolver')
                            ->label('DoH resolver')->url(),
                        // The http3_enabled DB column survives for
                        // forward-compat but is no longer surfaced as
                        // a toggle: the current VLESS+Reality stack
                        // is TCP-only, so advertising HTTP/3 would
                        // produce a recognisable failed-QUIC fallback.
                        Placeholder::make('http3_note')
                            ->label('HTTP/3 (QUIC)')
                            ->content('Disabled: the current VLESS+Reality stack is TCP-only. Advertising HTTP/3 would produce a fingerprintable failed-QUIC fallback.')
                            ->columnSpanFull(),
                    ])->columns(2),
            ])
            ->statePath('data');
    }

    public function save(): void
    {
        $config = ServerConfig::current();
        $data = $this->form->getState();
        $destHost = RealityDestinationCatalog::normalizeHost((string) ($data['reality_dest_host'] ?? ''));
        if (! RealityDestinationCatalog::isSelectableHost($destHost, (string) ($config->reality_dest_host ?? ''))) {
            $this->addError('data.reality_dest_host', 'Choose one of the curated Reality destination websites.');

            return;
        }
        $data['reality_dest_host'] = $destHost;

        $config->fill($data)->save();

        // The model's `updated` hook dispatches a queued
        // ReloadServerConfig message after commit instead of running
        // render subprocesses inline. Probe Redis once so the panel
        // can distinguish "queued" from "saved but queue unavailable"
        // without blocking on the render itself.
        $reloadOk = $this->probeReloadTransport();

        if ($reloadOk) {
            Notification::make()
                ->title('Server config saved')
                ->body(
                    'Render job queued. sing-box picks up changed config files automatically. Caddyfile changes are rendered here; the host-side operator update flow owns the live Caddy reload. '
                    .'If a change is not visible after a minute, check `docker compose logs panel` for `serverconfig.reload.dispatch_failed`.'
                )
                ->success()
                ->send();
        } else {
            Notification::make()
                ->title('Server config saved (reload path degraded)')
                ->body(
                    'The DB row was committed, but Redis appears unreachable from the panel right now. The Messenger render job will not run until Redis recovers. '
                    .'The every-5-min `singbox:render --if-changed` scheduler will reconcile sing-box once Redis is back. Run `docker compose ps redis` and grep `docker compose logs panel` for `serverconfig.reload.dispatch_failed`.'
                )
                ->warning()
                ->persistent()
                ->send();
        }
    }

    public function refreshRealityLatency(): void
    {
        $selected = RealityDestinationCatalog::normalizeHost((string) (
            $this->data['reality_dest_host']
            ?? ServerConfig::current()->reality_dest_host
            ?? ''
        ));

        RealityDestinationCatalog::refreshCatalogLatencies($selected);

        Notification::make()
            ->title('Reality destination latency refreshed')
            ->body(RealityDestinationCatalog::latencyStatusText($selected))
            ->success()
            ->send();
    }

    /**
     * Cheap synchronous probe — is Redis reachable right now?
     *
     * The Symfony Messenger transport depends on Redis being up. The
     * actual dispatch runs inside DB::afterCommit and can't surface
     * failure synchronously to the operator — by the time it fires,
     * save() has already returned and rendered a notification. A
     * cheap, timeout-bounded PING is a good enough proxy for "the
     * dispatch about to fire will work".
     *
     * False positives (Redis comes up between probe and dispatch)
     * just lose the operator a hint; harmless. False negatives
     * (Redis flaps during probe) likewise — the worst case is one
     * spurious "degraded" notification that the next save corrects.
     */
    private function probeReloadTransport(): bool
    {
        try {
            $pong = Redis::connection()->command('ping');

            return $pong === true || in_array((string) $pong, ['PONG', '+PONG'], true);
        } catch (Throwable $e) {
            return false;
        }
    }

    protected function getFormActions(): array
    {
        return [
            Action::make('save')->submit('save')->label('Save and reload'),
            Action::make('refreshRealityLatency')
                ->label('Check latency')
                ->icon('heroicon-o-signal')
                ->color('gray')
                ->action('refreshRealityLatency'),
        ];
    }
}
