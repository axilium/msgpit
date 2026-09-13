<?php

declare(strict_types=1);

namespace Msgpit\Core;

final class ProviderRegistry
{
    /** @var array<string, Provider> */
    private array $providers = [];

    /** @param list<Provider> $providers */
    public function __construct(array $providers)
    {
        foreach ($providers as $provider) {
            $this->providers[$provider->id()] = $provider;
        }
    }

    /**
     * @param list<class-string> $classes
     * @param list<string> $enabled Empty means all.
     */
    public static function fromClasses(array $classes, array $enabled = []): self
    {
        $providers = [];

        foreach ($classes as $class) {
            $provider = new $class();

            if (!$provider instanceof Provider) {
                throw new \InvalidArgumentException("{$class} does not implement " . Provider::class);
            }

            if ($enabled === [] || in_array($provider->id(), $enabled, true)) {
                $providers[] = $provider;
            }
        }

        return new self($providers);
    }

    public function get(string $id): ?Provider
    {
        return $this->providers[$id] ?? null;
    }

    /** @return list<Provider> */
    public function all(): array
    {
        return array_values($this->providers);
    }
}
