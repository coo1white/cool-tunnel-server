<?php

declare(strict_types=1);

namespace App\Filament\Resources\TrafficLogResource\Pages;

use App\Filament\Resources\TrafficLogResource;
use Filament\Resources\Pages\ListRecords;

class ListTrafficLogs extends ListRecords
{
    protected static string $resource = TrafficLogResource::class;
}
