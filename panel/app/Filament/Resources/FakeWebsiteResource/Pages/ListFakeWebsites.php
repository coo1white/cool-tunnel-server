<?php

declare(strict_types=1);

namespace App\Filament\Resources\FakeWebsiteResource\Pages;

use App\Filament\Resources\FakeWebsiteResource;
use Filament\Actions;
use Filament\Resources\Pages\ListRecords;

class ListFakeWebsites extends ListRecords
{
    protected static string $resource = FakeWebsiteResource::class;

    protected function getHeaderActions(): array
    {
        return [Actions\CreateAction::make()];
    }
}
