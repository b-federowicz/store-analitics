"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Plus, LoaderCircle } from "lucide-react";
import {
  APPLY_BUTTON_TEXT,
  CLEAR_BUTTON_TEXT,
  ALL_MARKETPLACES_LABEL,
  ALL_TRANSACTION_TYPES_LABEL,
  TRANSACTION_TYPES,
} from "@/constants";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../ui/select";
import { fetchOrderSourceGroups } from "@/lib/api/dashboard";
import type { SourceGroup } from "@/lib/types";

export function DashboardFilters({
  onClear,
  onApply,
  loading,
}: {
  onClear: () => void;
  onApply?: (
    search?: string,
    from?: string,
    to?: string,
    marketplace?: string,
    transactionType?: string
  ) => void;
  loading?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [marketplace, setMarketplace] = useState("");
  const [transactionType, setTransactionType] = useState("");
  const [sourceGroups, setSourceGroups] = useState<SourceGroup[]>([]);

  useEffect(() => {
    fetchOrderSourceGroups()
      .then(setSourceGroups)
      .catch((err) => console.error(err));
  }, []);

  const handleClear = () => {
    setSearch("");
    setFrom("");
    setTo("");
    setMarketplace("");
    setTransactionType("");
    onClear();
  };


  return (
    <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          placeholder="Search by order id, external id, delivery nr (space-separate for many)…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onApply?.(search, from, to, marketplace, transactionType);
          }}
          className="pl-8"
        />
      </div>
      <div className="flex items-center gap-2">
        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-auto"
        />
        <span className="text-muted-foreground text-sm">to</span>
        <Input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-auto"
        />
        <Select
          value={marketplace}
          onValueChange={(value) => setMarketplace(value as string)}
        >
          <SelectTrigger className="w-full max-w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Marketplace</SelectLabel>
              <SelectItem key="" value="">
                {ALL_MARKETPLACES_LABEL}
              </SelectItem>
              {sourceGroups.map((group) => (
                <SelectItem key={group.key} value={group.key}>
                  {group.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          value={transactionType}
          onValueChange={(value) => setTransactionType(value as string)}
        >
          <SelectTrigger className="w-full max-w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectLabel>Transaction type</SelectLabel>
              <SelectItem key="" value="">
                {ALL_TRANSACTION_TYPES_LABEL}
              </SelectItem>
              {TRANSACTION_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={onApply ? () => onApply(search, from, to, marketplace, transactionType) : undefined}
        >
          {loading ?
            <LoaderCircle className=" animate-spin" /> : <Plus />
          }
          {APPLY_BUTTON_TEXT}
        </Button>
        {(search || from || to || marketplace || transactionType) && (
          <Button variant="ghost" size="sm" onClick={handleClear}>
            {CLEAR_BUTTON_TEXT}
          </Button>
        )}
      </div>
    </div>
  );
}
