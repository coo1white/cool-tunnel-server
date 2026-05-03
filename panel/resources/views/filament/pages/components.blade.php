<x-filament-panels::page>
    <div class="grid grid-cols-3 gap-4 mb-6">
        <x-filament::section>
            <div class="text-2xl font-bold text-success-600">{{ $summary['ok'] }}</div>
            <div class="text-sm text-gray-500">OK</div>
        </x-filament::section>
        <x-filament::section>
            <div class="text-2xl font-bold {{ $summary['ng'] > 0 ? 'text-danger-600' : 'text-gray-400' }}">
                {{ $summary['ng'] }}
            </div>
            <div class="text-sm text-gray-500">NG</div>
        </x-filament::section>
        <x-filament::section>
            <div class="text-2xl font-bold">{{ $summary['total'] }}</div>
            <div class="text-sm text-gray-500">Total</div>
        </x-filament::section>
    </div>

    <x-filament::section>
        <table class="w-full text-sm">
            <thead>
                <tr class="border-b text-left text-gray-500">
                    <th class="px-3 py-2">Status</th>
                    <th class="px-3 py-2">Component</th>
                    <th class="px-3 py-2">Pinned</th>
                    <th class="px-3 py-2">Installed</th>
                    <th class="px-3 py-2">Diagnostic</th>
                </tr>
            </thead>
            <tbody>
            @forelse ($rows as $row)
                @php
                    $state = $row['state'] ?? 'unknown';
                    $isOk  = $state === 'ok';
                @endphp
                <tr class="border-b">
                    <td class="px-3 py-2">
                        <span class="px-2 py-1 rounded {{ $isOk ? 'bg-success-100 text-success-800' : 'bg-danger-100 text-danger-800' }}">
                            {{ $isOk ? 'OK' : 'NG' }}
                        </span>
                    </td>
                    <td class="px-3 py-2 font-mono">{{ $row['name'] ?? '?' }}</td>
                    <td class="px-3 py-2 font-mono">{{ $row['pinned_version'] ?? '' }}</td>
                    <td class="px-3 py-2 font-mono text-gray-600">{{ $row['installed_version'] ?? '—' }}</td>
                    <td class="px-3 py-2 text-gray-600">{{ $row['message'] ?? '' }}</td>
                </tr>
            @empty
                <tr>
                    <td colspan="5" class="px-3 py-6 text-center text-gray-500">
                        No components found. Make sure manifests/ is mounted into the panel container at /srv/manifests.
                    </td>
                </tr>
            @endforelse
            </tbody>
        </table>
    </x-filament::section>

    <p class="text-sm text-gray-500 mt-4">
        These are the swappable parts of your stack. See
        <code>docs/components.md</code> for how to update each one.
    </p>
</x-filament-panels::page>
