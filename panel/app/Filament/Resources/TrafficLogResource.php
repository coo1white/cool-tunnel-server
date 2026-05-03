<?php

declare(strict_types=1);

namespace App\Filament\Resources;

use App\Filament\Resources\TrafficLogResource\Pages;
use App\Models\TrafficLog;
use Filament\Resources\Resource;
use Filament\Tables;
use Filament\Tables\Table;

// Read-only view of the per-account, per-day traffic rollup.

class TrafficLogResource extends Resource
{
    protected static ?string $model = TrafficLog::class;
    protected static ?string $navigationIcon = 'heroicon-o-chart-bar';
    protected static ?string $navigationLabel = 'Traffic logs';
    protected static ?int $navigationSort = 30;

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                Tables\Columns\TextColumn::make('day')->date()->sortable(),
                Tables\Columns\TextColumn::make('proxyAccount.username')
                    ->label('Account')->searchable()->sortable(),
                Tables\Columns\TextColumn::make('uplink_bytes')
                    ->label('Up')
                    ->formatStateUsing(fn ($s) => self::human($s))
                    ->sortable(),
                Tables\Columns\TextColumn::make('downlink_bytes')
                    ->label('Down')
                    ->formatStateUsing(fn ($s) => self::human($s))
                    ->sortable(),
                Tables\Columns\TextColumn::make('connections')->sortable(),
            ])
            ->defaultSort('day', 'desc')
            ->paginated([25, 50, 100]);
    }

    public static function getPages(): array
    {
        return ['index' => Pages\ListTrafficLogs::route('/')];
    }

    public static function canCreate(): bool { return false; }
    public static function canEdit($record): bool { return false; }
    public static function canDelete($record): bool { return false; }

    private static function human(?int $b): string
    {
        if (! $b) return '0 B';
        $u = ['B','KiB','MiB','GiB','TiB'];
        $i = max(0, min((int) floor(log($b, 1024)), 4));
        return round($b / (1024 ** $i), 2).' '.$u[$i];
    }
}
