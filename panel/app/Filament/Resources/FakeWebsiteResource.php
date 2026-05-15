<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Filament\Resources;

use App\Filament\Resources\FakeWebsiteResource\Pages;
use App\Models\FakeWebsite;
use Filament\Forms;
use Filament\Forms\Form;
use Filament\Notifications\Notification;
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
                // Direct "Activate" action — pre-v0.0.64 operators had
                // to Edit → toggle is_active → Save to swap cover sites.
                // The single-active invariant is enforced atomically
                // by FakeWebsite::booted (lockForUpdate transaction in
                // the saved hook, v0.0.16); this action just sets
                // is_active = true and lets the model handle the swap.
                // Visible only on rows that aren't already active.
                Tables\Actions\Action::make('activate')
                    ->label('Activate')
                    ->icon('heroicon-o-check-circle')
                    ->color('success')
                    ->visible(fn (FakeWebsite $record): bool => ! $record->is_active)
                    ->requiresConfirmation()
                    ->modalHeading(fn (FakeWebsite $record): string => "Activate '{$record->name}'?")
                    ->modalDescription('This deactivates the currently-active cover site (if any) and switches the apex domain to render this one. Render + reload happen via the saved-hook chain.')
                    // Defense-in-depth: the Filament panel sits behind
                    // its own auth middleware so unauthenticated callers
                    // never reach this Livewire action under normal
                    // routing. The explicit closure exists as a
                    // belt-and-braces guard against a future refactor
                    // exposing the Livewire component via a different
                    // route. Switching the active cover site is a
                    // public-facing behavioural change (apex domain
                    // renders a different page) — worth authorizing
                    // explicitly. Mirrors ProxyAccountResource's
                    // regenerate_password / show_subscription_url
                    // guards.
                    ->authorize(fn (): bool => auth()->check())
                    ->action(function (FakeWebsite $record): void {
                        $record->is_active = true;
                        $record->save();
                        Notification::make()
                            ->title("'{$record->name}' is now the active cover site")
                            ->success()
                            ->send();
                    }),
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
