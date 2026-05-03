<?php

namespace App\Filament\Resources\ProxyAccountResource\Pages;

use App\Filament\Resources\ProxyAccountResource;
use App\Services\PasswordGenerator;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\CreateRecord;

class CreateProxyAccount extends CreateRecord
{
    protected static string $resource = ProxyAccountResource::class;

    protected function mutateFormDataBeforeCreate(array $data): array
    {
        $pw = PasswordGenerator::make();
        $data['password_hash'] = $pw['hash'];

        // Stash cleartext on the request so the after-create hook can
        // surface it. Never written to DB.
        session()->flash('cool_tunnel.proxy_account.cleartext', $pw['cleartext']);

        return $data;
    }

    protected function afterCreate(): void
    {
        $cleartext = session()->pull('cool_tunnel.proxy_account.cleartext');
        if ($cleartext) {
            Notification::make()
                ->title('New password — copy now, shown once')
                ->body("Username: {$this->record->username}\nPassword: {$cleartext}")
                ->success()
                ->persistent()
                ->send();
        }
    }
}
