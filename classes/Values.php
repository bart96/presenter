<?php

class Values
{
    private string $type;
    public array $values;

    public function __construct(string $type, array $values = [])
    {
        $this->type = $type . ' -> ';
        $this->values = $values;
    }

    public function has($attribute): bool
    {
        return isset($this->values[$attribute]);
    }

    /**
     * Whether the attribute was supplied at all (distinguishes an explicit null from an absent
     * key — unlike {@see has()}, which is isset-based and false for null values).
     */
    public function provided(string $attribute): bool
    {
        return array_key_exists($attribute, $this->values);
    }

    public function hasPath(string $name, bool $checkValue = true): bool
    {
        foreach ($this->values as $key => $value) {
            if ($value === $name) {
                return !$checkValue || isset($this->values[$key + 1]);
            }
        }

        return false;
    }

    public function isNumeric(... $attributes): bool
    {
        foreach ($attributes as $attribute) {
            if (!isset($this->values[$attribute])) {
                return false;
            }

            if ($this->values[$attribute] === '' || intval($this->values[$attribute]) < 0) {
                return false;
            }
        }

        return true;
    }

    public function check(... $attributes): Values
    {
        foreach ($attributes as $attribute) {
            if (!isset($this->values[$attribute])) {
                throw new Error($this->type . '[' . $attribute . '] is missing');
            }
        }

        return $this;
    }

    public function checkNumeric(... $attributes): Values
    {
        foreach ($attributes as $attribute) {
            if (!isset($this->values[$attribute])) {
                throw new Error($this->type . '[' . $attribute . '] is missing');
            }

            if ($this->values[$attribute] === '' || intval($this->values[$attribute]) < 0) {
                throw new Error($this->type . '[' . $attribute . '] is not a valid number');
            }
        }

        return $this;
    }

    public function add(string $key, $value): Values
    {
        $this->values[$key] = $value;

        return $this;
    }

    public function get(string $attribute, $default = null, $valueRequired = true): mixed
    {
        if (!isset($this->values[$attribute])) {
            if ($default === null && $valueRequired) {
                throw new Error($this->type . '[' . $attribute . '] is missing');
            }

            return $default;
        }

        return $this->values[$attribute];
    }

    public function getPath(string $name, $default = null, $valueRequired = true): mixed
    {
        foreach ($this->values as $key => $value) {
            if ($value === $name) {
                if (!isset($this->values[$key + 1])) {
                    if ($valueRequired) {
                        throw new Error($this->type . 'value for [' . $name . '] is missing');
                    }

                    return $default;
                }

                return $this->values[$key + 1];
            }
        }

        if ($default === null) {
            throw new Error($this->type . '[' . $name . '] is missing');
        }

        return $default;
    }

    public function getPathAsInt(string $name, $default = null): int
    {
        return intval($this->getPath($name, $default));
    }

    public function getPathAsBool(string $name, $default = null): bool
    {
        return boolval($this->getPath($name, $default));
    }

    public function getAsInt(string $attribute, ?int $default = null): int
    {
        return intval($this->get($attribute, $default));
    }

    public function getAsBool(string $attribute, ?bool $default = null): bool
    {
        return boolval($this->get($attribute, $default));
    }

    public function getAsArray(string $attribute, array $default = []): array
    {
        $value = $this->get($attribute, $default, false);
        if (is_array($value)) {
            return $value;
        }
        if (is_object($value)) {
            return (array)$value;
        }
        return $default;
    }

    public function getAsObject(string $attribute, $default = null): mixed
    {
        return $this->get($attribute, $default, false);
    }

    public function checkArray(string ...$attributes): Values
    {
        foreach ($attributes as $attribute) {
            if (!isset($this->values[$attribute])) {
                throw new Error($this->type . '[' . $attribute . '] is missing');
            }
            if (!is_array($this->values[$attribute])) {
                throw new Error($this->type . '[' . $attribute . '] must be an array');
            }
        }
        return $this;
    }

    public function checkObject(string ...$attributes): Values
    {
        foreach ($attributes as $attribute) {
            if (!isset($this->values[$attribute])) {
                throw new Error($this->type . '[' . $attribute . '] is missing');
            }
        }
        return $this;
    }
}
