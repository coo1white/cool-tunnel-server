<?php

declare(strict_types=1);

namespace App\Providers;

use App\Services\CaddyfileGenerator;
use App\Services\ComponentChecker;
use App\Services\CtServerCore;
use App\Services\RedisRevocationBus;
use App\Services\SingBoxConfigGenerator;
use App\Services\SingBoxReloader;
use App\Services\TrafficCollector;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(CtServerCore::class);
        $this->app->singleton(SingBoxConfigGenerator::class);
        $this->app->singleton(SingBoxReloader::class);
        $this->app->singleton(CaddyfileGenerator::class);
        $this->app->singleton(TrafficCollector::class);
        $this->app->singleton(ComponentChecker::class);
        $this->app->singleton(RedisRevocationBus::class);
    }

    public function boot(): void
    {
        // The Filament login page reaches us over HTTPS via sing-box's
        // fallback inbound; force https in URL generation so generated
        // form actions don't downgrade.
        if ($this->app->environment('production')) {
            URL::forceScheme('https');
        }

        $this->configureRateLimiters();
    }

    /**
     * H1 (2026-05-05 audit) — pre-fix, neither the Filament login
     * Livewire form nor the public subscription endpoint were rate-
     * limited at the framework layer. Brute-forcing an admin
     * password or enumerating subscription tokens was bounded only
     * by network bandwidth.
     *
     * Two named limiters live here:
     *
     *   `login`         — keyed on (email|ip), 5/min per identity
     *                     plus 20/min per IP overall. Consumed by
     *                     App\Filament\Pages\Auth\Login::authenticate
     *                     (the custom subclass registered in
     *                     AdminPanelProvider).
     *
     *   `subscription`  — keyed on IP, 60/min. The subscription URL
     *                     carries an HMAC token that's already
     *                     forgery-resistant; the throttle blocks
     *                     online enumeration of `account_id` (numeric
     *                     prefix) by capping requests-per-second.
     *                     Used as throttle:subscription middleware
     *                     in routes/web.php.
     *
     * The limits are deliberately tight: an operator typing their
     * password wrong 5 times in a minute can wait one minute. A
     * legitimate client will fetch its subscription manifest at
     * most a few times per day — 60/min is generous headroom.
     */
    private function configureRateLimiters(): void
    {
        RateLimiter::for('login', function (Request $request) {
            $email = (string) $request->input('email', '');
            $ip    = (string) $request->ip();

            return [
                Limit::perMinute(5)->by(strtolower($email).'|'.$ip),
                Limit::perMinute(20)->by($ip),
            ];
        });

        RateLimiter::for('subscription', function (Request $request) {
            return Limit::perMinute(60)->by((string) $request->ip());
        });
    }
}
