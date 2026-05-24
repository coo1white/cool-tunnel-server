<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Console\Commands;

use App\Models\ServerConfig;
use Illuminate\Console\Command;
use Throwable;

class RecoverResetReality extends Command
{
    protected $signature = 'recover:reset-reality';

    protected $description = 'Reset the encrypted Reality keypair after unrecoverable APP_KEY drift';

    public function handle(): int
    {
        try {
            $cfg = ServerConfig::query()->firstOrFail();
            $cfg->forceFill([
                'reality_private_key' => null,
                'reality_public_key' => null,
                'reality_short_ids' => [''],
            ])->saveQuietly();

            $cfg->refresh();
            $cfg->ensureRealityKeypair();
        } catch (Throwable $e) {
            $this->error('Reality reset failed: '.$e->getMessage());

            return self::FAILURE;
        }

        $this->info('new Reality keypair generated');
        $this->warn('Clients must re-import subscription URLs.');

        return self::SUCCESS;
    }
}
