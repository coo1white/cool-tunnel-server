<?php

declare(strict_types=1);

namespace App\Filament\Pages;

use App\Services\ComponentChecker;
use Filament\Notifications\Notification;
use Filament\Pages\Page;
use Filament\Actions\Action;

class ComponentsPage extends Page
{
    protected static ?string $navigationIcon  = 'heroicon-o-puzzle-piece';
    protected static ?string $navigationLabel = 'Components';
    protected static ?int    $navigationSort  = 80;
    protected static string  $view            = 'filament.pages.components';

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
                    Notification::make()->title('Component check refreshed')->success()->send();
                }),
        ];
    }

    public function refreshRows(bool $useCache): void
    {
        $checker = app(ComponentChecker::class);
        $this->rows    = $checker->check($useCache);
        $this->summary = $checker->summarize($this->rows);
    }
}
