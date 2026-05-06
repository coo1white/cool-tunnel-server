<?php

declare(strict_types=1);

namespace App\Filament\Pages;

use App\Models\ServerConfig;
use Filament\Actions\Action;
use Filament\Forms\Components\Placeholder;
use Filament\Forms\Components\Section;
use Filament\Forms\Components\TextInput;
use Filament\Forms\Components\Toggle;
use Filament\Forms\Concerns\InteractsWithForms;
use Filament\Forms\Contracts\HasForms;
use Filament\Forms\Form;
use Filament\Notifications\Notification;
use Filament\Pages\Page;

/**
 * @property Form $form Provided by InteractsWithForms (Filament magic).
 */
class ServerConfigPage extends Page implements HasForms
{
    use InteractsWithForms;

    protected static ?string $navigationIcon = 'heroicon-o-cog-6-tooth';

    protected static ?string $navigationLabel = 'Server config';

    protected static ?string $navigationGroup = 'System';

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
                        // Defense-in-depth: validate `domain` at the form
                        // layer in addition to the v0.0.16 render-layer
                        // `template::caddyfile_validate` guard. The render
                        // layer rejects metasyntactic chars (\n / { / } /
                        // ") with a clear error so the bad config never
                        // reaches Caddy — but a typo'd domain still
                        // persists in the DB and causes every render
                        // attempt to fail until the operator notices.
                        // The form regex below catches the typo at save
                        // time. RFC 1123 label / FQDN shape, max 253
                        // chars per RFC. (v0.0.21 — defense-in-depth.)
                        TextInput::make('domain')
                            ->required()
                            ->maxLength(253)
                            ->regex('/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i')
                            ->validationMessages([
                                'regex' => 'Must be a valid FQDN (e.g. proxy.example.com) — no spaces, no `{` `}` `"`, no newlines.',
                            ]),
                        TextInput::make('acme_email')->required()->email(),
                        TextInput::make('acme_directory')->required()->url(),
                    ])->columns(3),

                Section::make('Anti-tracking')
                    ->description('Defaults match what NaiveProxy clients expect. Saving regenerates the Caddyfile and the sing-box config, then hot-reloads both.')
                    ->schema([
                        Toggle::make('anti_tracking_hide_ip')->label('hide_ip'),
                        Toggle::make('anti_tracking_hide_via')->label('hide_via'),
                        Toggle::make('anti_tracking_probe_resistance')->label('probe_resistance'),
                        TextInput::make('anti_tracking_doh_resolver')
                            ->label('DoH resolver')->url(),
                        // The http3_enabled DB column survives for
                        // forward-compat but is no longer surfaced as
                        // a toggle: NaiveProxy is HTTP/2-only at the
                        // protocol level, so enabling it produced a
                        // recognisable network fingerprint
                        // (clients try QUIC, fail, fall back). See
                        // SubscriptionController class docstring.
                        Placeholder::make('http3_note')
                            ->label('HTTP/3 (QUIC)')
                            ->content('Disabled: NaiveProxy is HTTP/2-only by protocol design. Advertising HTTP/3 caused clients to attempt QUIC and fall back, producing a fingerprintable failure pattern. See cross-platform-clients.md.')
                            ->columnSpanFull(),
                    ])->columns(2),
            ])
            ->statePath('data');
    }

    public function save(): void
    {
        $config = ServerConfig::current();
        $config->fill($this->form->getState())->save();
        Notification::make()
            ->title('Server config saved')
            ->body('Caddyfile + sing-box config regenerated; both services hot-reloading.')
            ->success()
            ->send();
    }

    protected function getFormActions(): array
    {
        return [
            Action::make('save')->submit('save')->label('Save and reload'),
        ];
    }
}
