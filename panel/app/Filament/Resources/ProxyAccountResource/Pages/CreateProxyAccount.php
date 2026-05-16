<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Resources\ProxyAccountResource\Pages;

use App\Filament\Resources\ProxyAccountResource;
use App\Models\ProxyAccount;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\CreateRecord;
use Illuminate\Database\Eloquent\Model;

class CreateProxyAccount extends CreateRecord
{
    protected static string $resource = ProxyAccountResource::class;

    private ?string $generatedUuid = null;

    /**
     * The VLESS UUID lives outside $fillable (must go through
     * regenerateUuid() — see ProxyAccount::$fillable comment), so the
     * default Model::create($data) path would land a row with no
     * credential. We hand-build the model, seed the UUID through the
     * canonical setter, and save once.
     */
    protected function handleRecordCreation(array $data): Model
    {
        /** @var ProxyAccount $record */
        $record = new (static::getModel())($data);
        $this->generatedUuid = $record->regenerateUuid();
        $record->save();

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
        $body = "Username: {$record->username}\nUUID: {$this->generatedUuid}";
        if ($subUrl !== null) {
            $body .= "\n\nSubscription URL (import in the app — shown once):\n{$subUrl}";
        }

        Notification::make()
            ->title('New UUID — copy now, shown once')
            ->body($body)
            ->success()
            ->persistent()
            ->send();
    }
}
