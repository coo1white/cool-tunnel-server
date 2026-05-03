<?php

namespace App\Providers;

use App\Services\CaddyReloader;
use App\Services\CaddyfileGenerator;
use App\Services\ComponentChecker;
use App\Services\CtServerCore;
use App\Services\RedisRevocationBus;
use App\Services\TrafficCollector;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(CtServerCore::class);
        $this->app->singleton(CaddyfileGenerator::class);
        $this->app->singleton(CaddyReloader::class);
        $this->app->singleton(TrafficCollector::class);
        $this->app->singleton(ComponentChecker::class);
        $this->app->singleton(RedisRevocationBus::class);
    }

    public function boot(): void
    {
        // The Filament login page is reached via the Caddy edge over
        // HTTPS only; force https in URL generation so generated form
        // actions don't downgrade.
        if ($this->app->environment('production')) {
            URL::forceScheme('https');
        }
    }
}
