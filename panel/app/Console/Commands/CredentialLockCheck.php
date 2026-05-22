<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\ProxyAccount;
use Illuminate\Console\Command;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;

/**
 * v0.4 credential-lock guard.
 *
 * The old Rust guard compared DB basic-auth passwords against a rendered
 * /etc/sing-box/config.json file. v0.4 moved proxy credentials to VLESS UUIDs
 * and moved rendering to panel-side singbox-core, so the invariant now lives
 * where the data is decrypted and signed: the panel.
 */
class CredentialLockCheck extends Command
{
    private const PLACEHOLDER_USER = '__no_active_accounts__';

    private const PLACEHOLDER_UUID = '00000000-0000-0000-0000-000000000000';

    private const PREVIOUS_UUID_PREFIX = '__previous_uuid:';

    protected $signature = 'credential-lock:check
                            {--config=/data/config/singbox.json : Rendered sing-box server config path}';

    protected $description = 'Verify active DB UUIDs match rendered sing-box users and subscription manifests';

    public function handle(): int
    {
        $configPath = (string) $this->option('config');

        $db = $this->activeDbCredentials();
        if ($db === null) {
            return self::FAILURE;
        }

        $rendered = $this->renderedCredentials($configPath, $db === []);
        if ($rendered === null) {
            return self::FAILURE;
        }

        $subscription = $this->subscriptionCredentials($db);
        if ($subscription === null) {
            return self::FAILURE;
        }

        $failures = array_merge(
            $this->compareMaps('db', 'rendered', $db, $rendered),
            $this->compareMaps('db', 'manifest', $db, $subscription),
        );

        if ($failures !== []) {
            $this->error('credential-lock drift: '.implode('; ', $failures));

            return self::FAILURE;
        }

        $this->line('OK db=rendered=manifest=mac-config');

        return self::SUCCESS;
    }

    /**
     * @return array<string,string>|null username => uuid
     */
    private function activeDbCredentials(): ?array
    {
        $out = [];

        foreach (ProxyAccount::query()
            ->select(['id', 'username', 'uuid'])
            ->active()
            ->orderBy('username')
            ->cursor() as $account) {
            $username = (string) $account->username;
            $uuid = (string) ($account->uuid ?? '');

            if ($username === '') {
                $this->error('db has an active account with an empty username');

                return null;
            }
            if ($uuid === '') {
                $this->error("db active account {$username} has an empty UUID");

                return null;
            }

            $out[$username] = $uuid;
        }

        ksort($out);

        return $out;
    }

    /**
     * @return array<string,string>|null username => uuid
     */
    private function renderedCredentials(string $configPath, bool $allowPlaceholder): ?array
    {
        if (! is_file($configPath)) {
            $this->error("rendered sing-box config missing at {$configPath}");

            return null;
        }

        $raw = file_get_contents($configPath);
        if ($raw === false || trim($raw) === '') {
            $this->error("rendered sing-box config unreadable or empty at {$configPath}");

            return null;
        }

        try {
            $config = json_decode($raw, true, flags: JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            $this->error('rendered sing-box config is not valid JSON: '.$e->getMessage());

            return null;
        }

        if (! is_array($config)) {
            $this->error('rendered sing-box config root is not an object');

            return null;
        }

        $inbounds = $config['inbounds'] ?? null;
        if (! is_array($inbounds)) {
            $this->error('rendered sing-box config has no inbounds[] array');

            return null;
        }

        $users = null;
        foreach ($inbounds as $inbound) {
            if (! is_array($inbound)) {
                continue;
            }
            if (($inbound['type'] ?? null) !== 'vless') {
                continue;
            }
            $candidate = $inbound['users'] ?? null;
            if (is_array($candidate)) {
                $users = $candidate;
                break;
            }
        }

        if ($users === null) {
            $this->error('rendered sing-box config has no VLESS inbound users[]');

            return null;
        }

        $out = [];
        foreach ($users as $user) {
            if (! is_array($user)) {
                $this->error('rendered sing-box users[] contains a non-object entry');

                return null;
            }

            $username = (string) ($user['name'] ?? '');
            $uuid = (string) ($user['uuid'] ?? '');

            if (
                $allowPlaceholder
                && $username === self::PLACEHOLDER_USER
                && $uuid === self::PLACEHOLDER_UUID
            ) {
                continue;
            }

            if ($username === '' || $uuid === '') {
                $this->error('rendered sing-box users[] contains an entry with empty name or UUID');

                return null;
            }

            if (str_starts_with($username, self::PREVIOUS_UUID_PREFIX)) {
                continue;
            }

            $out[$username] = $uuid;
        }

        ksort($out);

        return $out;
    }

    /**
     * @param  array<string,string>  $db
     * @return array<string,string>|null username => uuid
     */
    private function subscriptionCredentials(array $db): ?array
    {
        if ($db === []) {
            return [];
        }

        $kernel = app(Kernel::class);
        $out = [];
        $i = 1;

        foreach (ProxyAccount::query()
            ->select(['id', 'username'])
            ->active()
            ->whereIn('username', array_keys($db))
            ->orderBy('username')
            ->cursor() as $account) {
            $username = (string) $account->username;
            if (! array_key_exists($username, $db)) {
                continue;
            }

            $token = $account->subscriptionToken();
            if ($token === '') {
                $this->error("subscription token unavailable for {$username}");

                return null;
            }

            $ip = '127.0.1.'.((($i - 1) % 250) + 1);
            RateLimiter::clear('subscription:'.$ip);

            $request = Request::create(
                '/api/v1/subscription/'.$token,
                'GET',
                server: [
                    'REMOTE_ADDR' => $ip,
                    'HTTP_ACCEPT' => 'application/json',
                ],
            );
            $response = $kernel->handle($request);
            try {
                $kernel->terminate($request, $response);
            } catch (\Throwable) {
                // Termination callbacks are not part of the credential
                // invariant; keep the guard focused on response content.
            }

            $contentType = (string) $response->headers->get('Content-Type', '');
            if ($response->getStatusCode() !== 200 || ! str_contains($contentType, 'application/json')) {
                $this->error("subscription manifest unavailable for {$username}");

                return null;
            }

            try {
                $manifest = json_decode((string) $response->getContent(), true, flags: JSON_THROW_ON_ERROR);
            } catch (\JsonException $e) {
                $this->error("subscription manifest for {$username} is not valid JSON: ".$e->getMessage());

                return null;
            }

            $profiles = is_array($manifest) ? ($manifest['profiles'] ?? null) : null;
            if (! is_array($profiles) || count($profiles) !== 1 || ! is_array($profiles[0])) {
                $this->error("subscription manifest for {$username} does not contain exactly one profile");

                return null;
            }

            $profileUsername = (string) ($profiles[0]['username'] ?? '');
            $uuid = (string) ($profiles[0]['uuid'] ?? '');
            if ($profileUsername === '' || $uuid === '') {
                $this->error("subscription manifest for {$username} has empty username or UUID");

                return null;
            }

            $out[$profileUsername] = $uuid;
            $i++;
        }

        ksort($out);

        return $out;
    }

    /**
     * @param  array<string,string>  $left
     * @param  array<string,string>  $right
     * @return list<string>
     */
    private function compareMaps(string $leftName, string $rightName, array $left, array $right): array
    {
        $leftUsers = array_keys($left);
        $rightUsers = array_keys($right);

        $missing = array_values(array_diff($leftUsers, $rightUsers));
        $extra = array_values(array_diff($rightUsers, $leftUsers));
        $mismatch = [];

        foreach (array_intersect($leftUsers, $rightUsers) as $username) {
            if ($left[$username] !== $right[$username]) {
                $mismatch[] = $username;
            }
        }

        $failures = [];
        if ($missing !== []) {
            $failures[] = "{$leftName}<->{$rightName} missing_in_{$rightName}=".implode(',', $missing);
        }
        if ($extra !== []) {
            $failures[] = "{$leftName}<->{$rightName} extra_in_{$rightName}=".implode(',', $extra);
        }
        if ($mismatch !== []) {
            $failures[] = "{$leftName}<->{$rightName} uuid_mismatch=".implode(',', $mismatch);
        }

        return $failures;
    }
}
