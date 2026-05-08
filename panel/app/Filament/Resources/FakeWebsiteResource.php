<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Resources;

use App\Filament\Resources\FakeWebsiteResource\Pages;
use App\Models\FakeWebsite;
use Filament\Forms;
use Filament\Forms\Form;
use Filament\Resources\Resource;
use Filament\Tables;
use Filament\Tables\Table;

class FakeWebsiteResource extends Resource
{
    protected static ?string $model = FakeWebsite::class;

    protected static ?string $navigationIcon = 'heroicon-o-globe-alt';

    protected static ?string $navigationLabel = 'Fake websites';

    protected static ?string $navigationGroup = 'System';

    protected static ?int $navigationSort = 20;

    public static function form(Form $form): Form
    {
        return $form->schema([
            Forms\Components\TextInput::make('slug')
                ->required()->alphaDash()->unique(ignoreRecord: true),

            Forms\Components\TextInput::make('name')->required(),

            Forms\Components\Select::make('template')
                ->options([
                    'blog' => 'Blog',
                    'corporate' => 'Corporate / Consultancy',
                    'portfolio' => 'Personal portfolio',
                ])
                ->required(),

            Forms\Components\TextInput::make('title'),
            Forms\Components\Textarea::make('tagline')->rows(2),

            Forms\Components\KeyValue::make('payload')
                ->keyLabel('Field')
                ->valueLabel('Content (use JSON for nested data)')
                ->reorderable(),

            Forms\Components\Toggle::make('is_active')
                ->helperText('Only one fake website can be active at a time. Toggling another off-then-on will swap.'),
        ]);
    }

    public static function table(Table $table): Table
    {
        return $table
            ->columns([
                Tables\Columns\TextColumn::make('name')->searchable()->sortable(),
                Tables\Columns\TextColumn::make('template')->badge(),
                Tables\Columns\IconColumn::make('is_active')->boolean()->label('Active'),
                Tables\Columns\TextColumn::make('updated_at')->dateTime()->since(),
            ])
            ->filters([
                Tables\Filters\TernaryFilter::make('is_active')->label('Currently active'),
            ])
            ->defaultSort('is_active', 'desc')
            ->actions([
                Tables\Actions\EditAction::make(),
                Tables\Actions\DeleteAction::make(),
            ]);
    }

    public static function getPages(): array
    {
        return [
            'index' => Pages\ListFakeWebsites::route('/'),
            'create' => Pages\CreateFakeWebsite::route('/create'),
            'edit' => Pages\EditFakeWebsite::route('/{record}/edit'),
        ];
    }
}
