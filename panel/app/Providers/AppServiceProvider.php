<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Providers;

use App\Contracts\CaddyfileGeneratorInterface;
use App\Contracts\ComponentCheckerInterface;
use App\Contracts\CtServerCoreInterface;
use App\Contracts\RevocationBusInterface;
use App\Contracts\SingboxConfigGeneratorInterface;
use App\Contracts\SingBoxConfigGeneratorInterface;
use App\Contracts\SingBoxReloaderInterface;
use App\Services\CaddyfileGenerator;
use App\Services\ComponentChecker;
use App\Services\CtServerCore;
use App\Services\RedisRevocationBus;
use App\Services\SingboxConfigGenerator;
use App\Services\SingBoxConfigGenerator;
use App\Services\SingBoxReloader;
use App\Services\TrafficCollector;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * PSR-style contract → concrete implementation map.
     *
     * v0.0.92 Phase 1 of the Symfony-infusion arc. Existing call
     * sites that resolve the concrete class directly (e.g.
     * `app(SingBoxConfigGenerator::class)`) keep working — the
     * concrete singleton registrations below preserve that path.
     * New / refactored code prefers the interface for testability:
     *
     *     public function __construct(
     *         private SingBoxConfigGeneratorInterface $gen,
     *     ) {}
     *
     * Phase 2 (Symfony Messenger handlers) will type-hint the
     * interface; Phase 3 (test rewrites) will bind fakes against
     * the interface in `$this->app->bind(...)`.
     */
    private const SERVICE_BINDINGS = [
        // SingBoxConfigGenerator (the legacy v0.1.x sing-box-on-the-
        // wire renderer) is kept as dead-code-no-effect for transitional
        // ct-server-core compatibility; full removal is a future
        // v0.4.x followup. The active v0.4.0+ renderer is
        // SingboxConfigGeneratorInterface (lowercase 'b') which
        // shells to singbox-core for VLESS+Reality config.json.
        SingBoxConfigGeneratorInterface::class => SingBoxConfigGenerator::class,
        SingBoxReloaderInterface::class => SingBoxReloader::class,
        CaddyfileGeneratorInterface::class => CaddyfileGenerator::class,
        // v0.4.0+ — singbox.json renderer (replaces v0.3.x
        // NaiveConfigGenerator). See SingboxConfigGeneratorInterface
        // for the lifecycle docs. Note the lowercase 'b' in
        // Singbox* — the sing-box upstream brand is hyphenated
        // (sing-box), conventionally rendered as Singbox in code.
        SingboxConfigGeneratorInterface::class => SingboxConfigGenerator::class,
        RevocationBusInterface::class => RedisRevocationBus::class,
        CtServerCoreInterface::class => CtServerCore::class,
        ComponentCheckerInterface::class => ComponentChecker::class,
    ];

    public function register(): void
    {
        // Concrete singletons — preserved so existing call sites
        // resolving by class name continue to work without churn.
        $this->app->singleton(CtServerCore::class);
        $this->app->singleton(SingBoxConfigGenerator::class);
        $this->app->singleton(SingBoxReloader::class);
        $this->app->singleton(CaddyfileGenerator::class);
        $this->app->singleton(SingboxConfigGenerator::class);
        $this->app->singleton(TrafficCollector::class);
        $this->app->singleton(ComponentChecker::class);
        $this->app->singleton(RedisRevocationBus::class);

        // Interface → concrete bindings. `$this->app->bind` (not
        // `singleton`) is enough here because the concrete is
        // already a singleton above; the container returns the
        // same instance for both keys.
        foreach (self::SERVICE_BINDINGS as $interface => $concrete) {
            $this->app->bind($interface, $concrete);
        }
    }

    public function boot(): void
    {
        // URL scheme handling — historical context.
        //
        // Pre-FrankenPHP-runtime-swap, this method called
        //   if (request()->isSecure()) { URL::forceScheme('https'); }
        // The intent was: emit https URLs only when the request
        // arrived via a real HTTPS terminator (or via a trusted
        // proxy forwarding X-Forwarded-Proto: https through the
        // TrustProxies middleware in bootstrap/app.php).
        //
        // That worked under PHP-FPM because boot() runs once per
        // request, so URL::forceScheme reset on every request. Under
        // Octane / FrankenPHP worker mode boot() runs ONCE per worker
        // and the per-request `if` was checked against whatever
        // request happened to be FIRST through that worker; the
        // global URL::forceScheme then leaked into every subsequent
        // request the worker handled. SSH-tunnel users would get
        // https redirects the moment any HTTPS-fronted request hit
        // the same worker — silent, intermittent breakage of the
        // documented loopback access path.
        //
        // Fix: drop the explicit URL::forceScheme. Laravel's URL
        // generator picks the scheme from the current request via
        // TrustProxies (trusts 127.0.0.1 + 172.16/12 — covers SSH
        // tunnel peer + docker bridge), AND from APP_URL when no
        // request is in scope (queue jobs, scheduler). When the
        // deferred R1-1 / R1-2 SNI router lands and forwards
        // X-Forwarded-Proto: https, URL generation will respect it
        // automatically — no service-provider gymnastics needed.

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
            $ip = (string) $request->ip();

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
