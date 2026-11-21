import { useEffect, useState } from "react";
import {
  getSyncPreferences,
  subscribeSyncPreferences,
  type SyncPreferences,
} from "@/lib/sync-preferences";

export const useSyncPreferences = (scope?: string): SyncPreferences => {
  const [preferences, setPreferences] = useState<SyncPreferences>(() => getSyncPreferences(scope));

  useEffect(() => {
    setPreferences(getSyncPreferences(scope));
    return subscribeSyncPreferences(scope, setPreferences);
  }, [scope]);

  return preferences;
};