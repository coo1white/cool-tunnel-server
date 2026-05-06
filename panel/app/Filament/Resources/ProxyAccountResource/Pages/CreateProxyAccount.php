<?php

declare(strict_types=1);

namespace App\Filament\Resources\ProxyAccountResource\Pages;

use App\Filament\Resources\ProxyAccountResource;
use App\Models\ProxyAccount;
use App\Services\PasswordGenerator;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\CreateRecord;

class CreateProxyAccount extends CreateRecord
{
    protected static string $resource = ProxyAccountResource::class;

    /**
     * Generate a fresh proxy password right after the record exists,
     * via the dedicated `setCleartextPassword()` setter. We do NOT
     * inject password_hash / password_cleartext_encrypted into the
     * form data — those columns are deliberately outside $fillable on
     * the model so that no other code path can poison them.
     *
     * The cleartext is shown in a one-time-only success notification;
     * it is never persisted in plaintext (the bcrypt hash + a Laravel-
     * Crypt-encrypted copy are what land in the DB).
     */
    protected function afterCreate(): void
    {
        /** @var ProxyAccount $record */
        $record = $this->record;
        $pw = PasswordGenerator::make();
        $record->setCleartextPassword($pw['cleartext']);
        $record->save();

        $subUrl = $record->subscriptionUrl();
        $username = (string) $record->getAttribute('username');
        $body = "Username: {$username}\nPassword: {$pw['cleartext']}";
        if ($subUrl !== null) {
            $body .= "\n\nSubscription URL (import in the app — shown once):\n{$subUrl}";
        }

        Notification::make()
            ->title('New password — copy now, shown once')
            ->body($body)
            ->success()
            ->persistent()
            ->send();
    }
}
