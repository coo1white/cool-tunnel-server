<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Resources\ProxyAccountResource\Pages;

use App\Contracts\SingBoxConfigGeneratorInterface;
use App\Filament\Resources\ProxyAccountResource;
use App\Models\ProxyAccount;
use App\Models\ServerConfig;
use App\Support\RealityDestinations;
use App\Support\SingBoxProtocolCatalog;
use Filament\Notifications\Actions\Action;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\CreateRecord;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;
use Throwable;

class CreateProxyAccount extends CreateRecord
{
    protected static string $resource = ProxyAccountResource::class;

    private ?string $generatedUuid = null;

    private ?string $selectedRealityDestHost = null;

    /** @var list<string> */
    private array $selectedProtocols = [];

    private bool $renderConfirmed = false;

    /**
     * The VLESS UUID lives outside $fillable (must go through
     * regenerateUuid() — see ProxyAccount::$fillable comment), so the
     * default Model::create($data) path would land a row with no
     * credential. We hand-build the model, seed the UUID through the
     * canonical setter, and save once.
     */
    protected function handleRecordCreation(array $data): Model
    {
        unset($data['reality_dest_host']);
        $protocols = SingBoxProtocolCatalog::defaultKeys();
        $data['enabled_protocols'] = $protocols;

        $rawLocalPort = $data['client_default_local_port'] ?? 1080;
        if (! is_int($rawLocalPort) && ! ctype_digit((string) $rawLocalPort)) {
            throw ValidationException::withMessages([
                'client_default_local_port' => 'Choose a whole-number local SOCKS port.',
            ]);
        }
        $localPort = (int) $rawLocalPort;
        if ($localPort < 1024 || $localPort > 65535) {
            throw ValidationException::withMessages([
                'client_default_local_port' => 'Choose a local SOCKS port between 1024 and 65535.',
            ]);
        }
        $data['client_default_local_port'] = $localPort;

        /** @var ProxyAccount $record */
        $record = DB::transaction(function () use ($data): ProxyAccount {
            $config = ServerConfig::current();
            $destHost = RealityDestinations::normaliseHost((string) ($config->reality_dest_host ?? ''));
            if (! RealityDestinations::isValidHost($destHost)) {
                throw ValidationException::withMessages([
                    'client_default_local_port' => 'Set a valid Reality destination in Server config before creating accounts.',
                ]);
            }

            $this->selectedRealityDestHost = $destHost;

            /** @var ProxyAccount $record */
            $record = new (static::getModel())($data);
            $this->generatedUuid = $record->regenerateUuid();
            $record->save();

            return $record;
        });

        $this->selectedProtocols = $protocols;
        $this->renderConfirmed = $this->renderSingBoxNow();

        return $record;
    }

    /**
     * Show the UUID once. The credential is also persisted in the DB
     * as plain text (the column IS the credential — see ProxyAccount
     * head comment for why encrypt-at-rest was dropped in v0.4.0).
     * Recover via the "Regenerate UUID" action — there is no "show
     * existing UUID" path by design.
     */
    protected function afterCreate(): void
    {
        /** @var ProxyAccount $record */
        $record = $this->record;

        $subUrl = $record->subscriptionUrl();
        $destHost = $this->selectedRealityDestHost
            ?? RealityDestinations::normaliseHost((string) (ServerConfig::current()->reality_dest_host ?? ''));
        $destLabel = RealityDestinations::label($destHost, RealityDestinations::latencyMs($destHost));
        $protocolLabels = array_map(
            fn (string $key): string => SingBoxProtocolCatalog::label(
                $key,
                ServerConfig::current(),
                $destHost,
                measureLatency: true,
            ),
            $this->selectedProtocols ?: $record->enabledProtocolKeys(),
        );
        $port = (int) $record->client_default_local_port;
        $body = "Username: {$record->username}\nUUID: {$this->generatedUuid}\nLocal SOCKS port: {$port}\nReality dest_host: {$destLabel}";
        if ($protocolLabels !== []) {
            $body .= "\nProtocols:\n- ".implode("\n- ", $protocolLabels);
        }
        if ($subUrl !== null) {
            $body .= "\n\nSubscription URL (import in the app):\n{$subUrl}";
        }
        $body .= $this->renderConfirmed
            ? "\n\nsing-box config rendered now; the URL is ready to import."
            : "\n\nReload queued, but immediate render was not confirmed. If import fails, wait a few seconds and retry, then check panel logs for singbox.render.*.";

        $actions = [];
        if ($subUrl !== null) {
            $jsUrl = json_encode($subUrl, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            $actions[] = Action::make('copy_subscription_url')
                ->label('Copy URL')
                ->icon('heroicon-o-clipboard')
                ->color('gray')
                ->extraAttributes([
                    'x-on:click' => "navigator.clipboard?.writeText({$jsUrl})",
                ]);
        }

        $notification = Notification::make()
            ->title($this->renderConfirmed ? 'Proxy account created — URL ready' : 'Proxy account created — reload queued')
            ->body($body)
            ->persistent()
            ->actions($actions);

        if ($this->renderConfirmed) {
            $notification->success();
        } else {
            $notification->warning();
        }
        $notification->send();

        if ($subUrl === null) {
            Notification::make()
                ->title('Subscription URL not generated')
                ->body('APP_KEY or PANEL_DOMAIN is not configured. Fix panel config before importing this account.')
                ->warning()
                ->persistent()
                ->send();
        }
    }

    private function renderSingBoxNow(): bool
    {
        try {
            $hash = app(SingBoxConfigGeneratorInterface::class)->renderToFile();

            return $hash !== null && Str::length($hash) === 64;
        } catch (Throwable $e) {
            Log::warning('proxy_account.create.immediate_render_failed', [
                'err' => $e->getMessage(),
                'type' => $e::class,
            ]);

            return false;
        }
    }
}
