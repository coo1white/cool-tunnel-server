<?php

declare(strict_types=1);

namespace App\Filament\Pages;

use App\Models\ServerConfig;
use Filament\Forms\Components\Section;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Forms\Concerns\InteractsWithForms;
use Filament\Forms\Contracts\HasForms;
use Filament\Forms\Form;
use Filament\Notifications\Notification;
use Filament\Pages\Page;

class ServerConfigPage extends Page implements HasForms
{
    use InteractsWithForms;

    protected static ?string $navigationIcon = 'heroicon-o-cog-6-tooth';
    protected static ?string $navigationLabel = 'Server config';
    protected static ?int $navigationSort = 90;
    protected static string $view = 'filament.pages.server-config';

    public ?array $data = [];

    public function mount(): void
    {
        $this->form->fill(ServerConfig::current()->toArray());
    }

    public function form(Form $form): Form
    {
        return $form
            ->schema([
                Section::make('Identity')
                    ->schema([
                        TextInput::make('domain')->required(),
                        TextInput::make('acme_email')->required()->email(),
                        TextInput::make('acme_directory')->required()->url(),
                    ])->columns(3),

                Section::make('Anti-tracking')
                    ->description('Defaults match what NaiveProxy clients expect. Toggling these regenerates Caddyfile and hot-reloads Caddy.')
                    ->schema([
                        Toggle::make('anti_tracking_hide_ip')->label('hide_ip'),
                        Toggle::make('anti_tracking_hide_via')->label('hide_via'),
                        Toggle::make('anti_tracking_probe_resistance')->label('probe_resistance'),
                        TextInput::make('anti_tracking_doh_resolver')
                            ->label('DoH resolver')->url(),
                        Toggle::make('http3_enabled')->label('Enable HTTP/3 (QUIC)'),
                    ])->columns(2),

                Section::make('Edge auth (extra layer in front of /admin)')
                    ->description('Generate the hash with: caddy hash-password -plaintext "your-password"')
                    ->schema([
                        TextInput::make('admin_basic_auth_user'),
                        TextInput::make('admin_basic_auth_hash'),
                    ])->columns(2),
            ])
            ->statePath('data');
    }

    public function save(): void
    {
        $config = ServerConfig::current();
        $config->fill($this->form->getState())->save();
        Notification::make()->title('Server config saved — Caddy reloading')->success()->send();
    }

    protected function getFormActions(): array
    {
        return [
            \Filament\Actions\Action::make('save')->submit('save')->label('Save and reload'),
        ];
    }
}
