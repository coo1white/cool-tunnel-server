<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Pages\Auth;

use App\Models\User;
use Filament\Forms\Components\Component;
use Filament\Forms\Components\TextInput;
use Filament\Pages\Auth\EditProfile as FilamentEditProfile;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Hash;
use Illuminate\Validation\Rules\Password;

class EditProfile extends FilamentEditProfile
{
    protected function getPasswordFormComponent(): Component
    {
        return TextInput::make('password')
            ->label('New password')
            ->password()
            ->revealable(filament()->arePasswordsRevealable())
            ->rule(Password::default())
            ->autocomplete('new-password')
            ->required(fn (): bool => $this->getUser() instanceof User && $this->getUser()->must_change_password === true)
            ->dehydrated(fn ($state): bool => filled($state))
            ->dehydrateStateUsing(fn ($state): string => Hash::make((string) $state))
            ->live(debounce: 500)
            ->same('passwordConfirmation');
    }

    protected function handleRecordUpdate(Model $record, array $data): Model
    {
        if (! $record instanceof User) {
            return parent::handleRecordUpdate($record, $data);
        }

        $record->name = (string) $data['name'];
        $record->email = (string) $data['email'];

        if (isset($data['password']) && filled($data['password'])) {
            $record->password = (string) $data['password'];
            $record->must_change_password = false;
        }

        $record->save();

        return $record;
    }
}
