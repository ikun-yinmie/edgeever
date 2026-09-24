import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiRequestError, api, type InstanceAdminSettings, type InstanceAdminSettingsUpdatePayload } from "@/lib/api";

export const INSTANCE_ADMIN_SETTINGS_QUERY_KEY = ["instance-admin-settings"];

/**
 * Shared draft/save plumbing for the site-level admin tabs. Each tab owns its
 * own slice of `InstanceAdminSettings` and saves only the fields it renders, so
 * the partial PATCH never clobbers settings another tab is responsible for.
 */
export const useInstanceAdminSettings = () => {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: INSTANCE_ADMIN_SETTINGS_QUERY_KEY,
    queryFn: api.getInstanceAdminSettings,
  });
  const [draft, setDraft] = useState<InstanceAdminSettings | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settingsQuery.data?.settings) setDraft(settingsQuery.data.settings);
  }, [settingsQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (payload: InstanceAdminSettingsUpdatePayload) => api.updateInstanceAdminSettings(payload),
    onSuccess: (data) => {
      setDraft(data.settings);
      setSavedAt(Date.now());
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey: INSTANCE_ADMIN_SETTINGS_QUERY_KEY });
    },
    onError: (error) => {
      setSaveError(error instanceof ApiRequestError ? error.message : String(error));
    },
  });

  const update = (patch: Partial<InstanceAdminSettings>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const save = (payload: InstanceAdminSettingsUpdatePayload, onSaved?: () => void) => {
    saveMutation.mutate(payload, { onSuccess: () => onSaved?.() });
  };

  return {
    draft,
    isLoading: settingsQuery.isLoading,
    isSaving: saveMutation.isPending,
    savedAt,
    saveError,
    update,
    save,
  };
};
