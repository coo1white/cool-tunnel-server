<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Pages;

use App\Services\ComponentChecker;
use Filament\Actions\Action;
use Filament\Notifications\Notification;
use Filament\Pages\Page;

class ComponentsPage extends Page
{
    protected static ?string $navigationIcon = 'heroicon-o-puzzle-piece';

    protected static ?string $navigationLabel = 'Components';

    protected static ?string $navigationGroup = 'System';

    protected static ?int $navigationSort = 80;

    protected static string $view = 'filament.pages.components';

    /** @var array<int, array<string, mixed>> */
    public array $rows = [];

    public array $summary = ['ok' => 0, 'ng' => 0, 'total' => 0];

    public function mount(): void
    {
        $this->refreshRows(useCache: true);
    }

    public function getHeaderActions(): array
    {
        return [
            Action::make('recheck')
                ->label('Re-check')
                ->icon('heroicon-o-arrow-path')
                ->action(function () {
                    $this->refreshRows(useCache: false);
                    // Surface the NG count in the notification — the
                    // pre-v0.0.64 generic "Component check refreshed"
                    // didn't tell the operator whether anything had
                    // actually flipped to NG. Operators were having to
                    // scan the table after every recheck.
                    $ng = (int) ($this->summary['ng'] ?? 0);
                    $total = (int) ($this->summary['total'] ?? 0);
                    if ($ng > 0) {
                        Notification::make()
                            ->title("Refreshed: {$ng} of {$total} NG")
                            ->body('Scroll to the highlighted rows for the diagnostic message.')
                            ->danger()
                            ->send();
                    } else {
                        Notification::make()
                            ->title("Refreshed: all {$total} OK")
                            ->success()
                            ->send();
                    }
                }),
        ];
    }

    public function refreshRows(bool $useCache): void
    {
        $checker = app(ComponentChecker::class);
        $this->rows = $checker->check($useCache);
        $this->summary = $checker->summarize($this->rows);
    }
}
