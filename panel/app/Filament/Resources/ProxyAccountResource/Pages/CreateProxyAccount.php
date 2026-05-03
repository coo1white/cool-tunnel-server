<?php

namespace App\Filament\Resources\ProxyAccountResource\Pages;

use App\Filament\Resources\ProxyAccountResource;
use App\Services\PasswordGenerator;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\CreateRecord;
use Illuminate\Support\Facades\Crypt;

class CreateProxyAccount extends CreateRecord
{
    protected static string $resource = ProxyAccountResource::class;

    protected function mutateFormDataBeforeCreate(array $data): array
    {
        $pw = PasswordGenerator::make();
        $data['password_hash']                  = $pw['hash'];
        // sing-box checks the cleartext at request time. Persist it
        // encrypted; ct-server-core decrypts at render time using
        // Laravel's AES-256-GCM envelope (see laravel_crypt.rs).
        $data['password_cleartext_encrypted']   = Crypt::encryptString($pw['cleartext']);

        // Stash cleartext on the session so afterCreate can show it.
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
