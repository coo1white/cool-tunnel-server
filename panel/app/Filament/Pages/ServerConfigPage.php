<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Pages;

use App\Models\ServerConfig;
use Filament\Actions\Action;
use Filament\Forms\Components\Placeholder;
use Filament\Forms\Components\Section;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Forms\Concerns\InteractsWithForms;
use Filament\Forms\Contracts\HasForms;
use Filament\Forms\Form;
use Filament\Notifications\Notification;
use Filament\Pages\Page;
use Illuminate\Support\Facades\Redis;
use Throwable;

/**
 * @property Form $form Provided by InteractsWithForms (Filament magic).
 */
class ServerConfigPage extends Page implements HasForms
{
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

                Section::make('Anti-tracking')
                    ->description('Defaults match what NaiveProxy clients expect. Saving regenerates the Caddyfile and the sing-box config, then hot-reloads both.')
                    ->schema([
                        Toggle::make('anti_tracking_hide_ip')->label('hide_ip'),
                        Toggle::make('anti_tracking_hide_via')->label('hide_via'),
                        Toggle::make('anti_tracking_probe_resistance')->label('probe_resistance'),
                        TextInput::make('anti_tracking_doh_resolver')
                            ->label('DoH resolver')->url(),
                        // The http3_enabled DB column survives for
                        // forward-compat but is no longer surfaced as
                        // a toggle: NaiveProxy is HTTP/2-only at the
                        // protocol level, so enabling it produced a
                        // recognisable network fingerprint
                        // (clients try QUIC, fail, fall back). See
                        // SubscriptionController class docstring.
                        Placeholder::make('http3_note')
                            ->label('HTTP/3 (QUIC)')
                            ->content('Disabled: NaiveProxy is HTTP/2-only by protocol design. Advertising HTTP/3 caused clients to attempt QUIC and fall back, producing a fingerprintable failure pattern. See cross-platform-clients.md.')
                            ->columnSpanFull(),
                    ])->columns(2),
            ])
            ->statePath('data');
    }

    public function save(): void
    {
        $config = ServerConfig::current();
        $config->fill($this->form->getState())->save();

        // v0.0.84 robustness-review fix (item 7): the model's
        // `updated` hook now dispatches `ReloadServerConfigJob`
        // (queued) instead of running the renders + clash-API
        // reload inline inside this request. The notification body
        // reflects the new contract — the row is committed, the
        // Redis fast-path is in flight, and the panel-side
        // render+reload backstop is queued. Pre-fix this said
        // "regenerated; hot-reloading" unconditionally, even when
        // the inline shell-outs had silently failed and the
        // on-disk config still reflected the previous state.
        //
        // Post-save Redis health probe (audit hardening): both the
        // Redis fast-path AND the Messenger transport for the
        // backstop job run against Redis. If Redis is unreachable
        // at the moment of save, neither path will reach sing-box
        // until the every-5-min scheduler reconciles. Surface that
        // synchronously instead of showing an unconditional success
        // banner. The DB row IS committed in either case; this is
        // strictly an operator hint, not a save failure.
        $reloadOk = $this->probeReloadTransport();

        if ($reloadOk) {
            Notification::make()
                ->title('Server config saved')
                ->body(
                    'Reload queued. The Redis fast-path is already in flight (≤100ms); the panel-side render+reload backstop will land within seconds. '
                    .'If the Components page reports drift after a minute, check `docker compose logs panel` for `serverconfig.reload.dispatch_failed`.'
                )
                ->success()
                ->send();
        } else {
            Notification::make()
                ->title('Server config saved (reload path degraded)')
                ->body(
                    'The DB row was committed, but Redis appears unreachable from the panel right now. The Redis fast-path and the Messenger backstop will both fail until Redis recovers. '
                    .'The every-5-min `singbox:render --if-changed --reload` scheduler will reconcile once Redis is back. Run `docker compose ps redis` and grep `docker compose logs panel` for `serverconfig.reload.dispatch_failed`.'
                )
                ->warning()
                ->persistent()
                ->send();
        }
    }

    /**
     * Cheap synchronous probe — is Redis reachable right now?
     *
     * Both the fast-path (RedisRevocationBus pub/sub) and the slow-
     * path backstop (Symfony Messenger over Redis transport) depend
     * on Redis being up. The actual dispatch runs inside
     * DB::afterCommit and can't surface failure synchronously to
     * the operator — by the time it fires, save() has already
     * returned and rendered a notification. A 1s PING is a good
     * enough proxy for "the dispatch about to fire will work".
     *
     * False positives (Redis comes up between probe and dispatch)
     * just lose the operator a hint; harmless. False negatives
     * (Redis flaps during probe) likewise — the worst case is one
     * spurious "degraded" notification that the next save corrects.
     */
    private function probeReloadTransport(): bool
    {
        try {
            $pong = Redis::connection()->command('PING');

            return $pong === true || $pong === 'PONG' || $pong === '+PONG';
        } catch (Throwable $e) {
            return false;
        }
    }

    protected function getFormActions(): array
    {
        return [
            Action::make('save')->submit('save')->label('Save and reload'),
        ];
    }
}
