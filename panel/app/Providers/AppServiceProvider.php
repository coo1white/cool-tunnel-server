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
     * H1 (2026-05-05 audit) — pre-fix, the Filament login Livewire
     * form was not rate-limited at the framework layer; brute-
     * forcing an admin password was bounded only by network
     * bandwidth.
     *
     * The `login` named limiter lives here:
     *
     *   `login`  — keyed on (email|ip), 5/min per identity plus
     *              20/min per IP overall. Consumed by
     *              App\Filament\Pages\Auth\Login::authenticate
     *              (the custom subclass registered in
     *              AdminPanelProvider).
     *
     * The subscription endpoint's rate limit is *not* registered
     * here — it's enforced inside SubscriptionController via the
     * lower-level RateLimiter::tooManyAttempts/hit API. We avoided
     * `throttle:subscription` middleware because a 429 response
     * leaks the endpoint's existence to a probe (vs. the cover-
     * site 200 returned by FakeSiteController for any unknown
     * path). The controller falls through to FakeSiteController
     * on rate-limit hit, preserving byte-level parity with the
     * cover-site catch-all. (v0.0.14 anti-enum refinement.)
     */
    private function configureRateLimiters(): void
    {
        RateLimiter::for('login', function (Request $request) {
            $email = (string) $request->input('email', '');
            $ip    = (string) $request->ip();

            return [
                // Per (email|ip): catches a single attacker hammering
                // one email from one source.
                Limit::perMinute(5)->by(strtolower($email).'|'.$ip),
                // Per IP: catches a single attacker rotating emails.
                Limit::perMinute(20)->by($ip),
                // Per email: catches a botnet rotating IPs against a
                // single email. Without this third dimension, an
                // attacker controlling N source IPs effectively raises
                // the cap to 5×N/min on any one email — defeating
                // both keys above. Kept generous (20/min) so a typo-
                // prone real admin retrying from a few devices isn't
                // locked out, while a distributed brute-force is
                // still capped at 1200/hr against any single email.
                // (v0.0.14 hardening of H1.)
                Limit::perMinute(20)->by('email:'.strtolower($email)),
            ];
        });
    }
}
