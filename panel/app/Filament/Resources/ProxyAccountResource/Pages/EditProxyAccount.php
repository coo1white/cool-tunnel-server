<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Resources\ProxyAccountResource\Pages;

use App\Filament\Resources\ProxyAccountResource;
use App\Support\SingBoxRenderConfirmation;
use Filament\Actions;
use Filament\Notifications\Notification;
use Filament\Resources\Pages\EditRecord;

class EditProxyAccount extends EditRecord
{
    protected static string $resource = ProxyAccountResource::class;

    protected function getHeaderActions(): array
    {
        return [
            Actions\DeleteAction::make()
                ->successNotification(null)
                ->after(fn () => $this->sendRenderNotification('Proxy account deleted', 'proxy_account.delete')),
        ];
    }

    public function save(bool $shouldRedirect = true, bool $shouldSendSavedNotification = true): void
    {
        parent::save($shouldRedirect, false);

        $renderConfirmed = SingBoxRenderConfirmation::renderNow('proxy_account.edit');

        if ($shouldSendSavedNotification) {
            $this->sendRenderNotification('Proxy account saved', $renderConfirmed);
        }
    }

    private function sendRenderNotification(string $title, string|bool $contextOrRenderConfirmed): void
    {
        $this->sendRenderNotificationForResult(
            $title,
            is_bool($contextOrRenderConfirmed)
                ? $contextOrRenderConfirmed
                : SingBoxRenderConfirmation::renderNow($contextOrRenderConfirmed),
        );
    }

    private function sendRenderNotificationForResult(string $title, bool $renderConfirmed): void
    {
        $notification = Notification::make()
            ->title($renderConfirmed ? "{$title} — config current" : "{$title} — reload queued")
            ->body($renderConfirmed
                ? 'sing-box config rendered now; client imports use the current account state.'
                : 'The DB row was saved, but immediate render was not confirmed. The worker or every-5-min scheduler will reconcile sing-box; check panel logs for singbox.render.* if the client state still looks stale.')
            ->persistent();

        if ($renderConfirmed) {
            $notification->success();
        } else {
            $notification->warning();
        }

        $notification->send();
    }
}
