<?php

declare(strict_types=1);

namespace App\Filament\Resources\ProxyAccountResource\Pages;

use App\Filament\Resources\ProxyAccountResource;
use App\Models\ProxyAccount;
use App\Services\PasswordGenerator;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\CreateRecord;
use Illuminate\Database\Eloquent\Model;

class CreateProxyAccount extends CreateRecord
{
    protected static string $resource = ProxyAccountResource::class;

    private ?string $generatedCleartext = null;

    /**
     * Set the cleartext password BEFORE the first INSERT — `password_hash`
     * is NOT NULL in the schema and is deliberately outside $fillable,
     * so the default `Model::create($data)` path would fail the NOT NULL
     * constraint. We hand-build the model, seed both password columns
     * via the dedicated setter, and save once.
     */
    protected function handleRecordCreation(array $data): Model
    {
        $pw = PasswordGenerator::make();
        $this->generatedCleartext = $pw['cleartext'];

        /** @var ProxyAccount $record */
        $record = new (static::getModel())($data);
        $record->setCleartextPassword($pw['cleartext']);
        $record->save();

        return $record;
    }

    /**
     * Show the cleartext once. Never persisted in plaintext — the bcrypt
     * hash + a Laravel-Crypt-encrypted copy are what land in the DB.
     */
    protected function afterCreate(): void
    {
        /** @var ProxyAccount $record */
        $record = $this->record;

        $subUrl = $record->subscriptionUrl();
        $body = "Username: {$record->username}\nPassword: {$this->generatedCleartext}";
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
