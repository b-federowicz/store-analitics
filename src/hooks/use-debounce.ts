import { useEffect, useState } from "react";


function useDebounce<T>(value: T, delay: number): { debouncedValue: T } {
  const [debouncedValue, setDebouncedValue] = useState(value);
  const [prevValue, setPrevValue] = useState(value);

  const isEmptyString = typeof value === "string" && value.trim().length === 0;
  if (value !== prevValue && isEmptyString) {
    setPrevValue(value);
    setDebouncedValue(value);
  }

  useEffect(() => {
    if (isEmptyString) {
      return;
    }

    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay, isEmptyString]);

  return { debouncedValue };
}

export default useDebounce;