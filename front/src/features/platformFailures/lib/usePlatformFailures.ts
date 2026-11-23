import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type { PlatformFailure } from "@/api/types";
import { PLATFORM_FAILURES_KEY, PLATFORM_FAILURES_POLL_MS, platformFailuresApi } from "../api";

const NO_PLATFORM_FAILURES: readonly PlatformFailure[] = [];

export function usePlatformFailures({ isPolling }: { isPolling: boolean }) {
  const failuresQuery = useQuery({
    queryKey: PLATFORM_FAILURES_KEY,
    queryFn: platformFailuresApi.list,
    refetchInterval: isPolling ? PLATFORM_FAILURES_POLL_MS : false,
  });
  return { failures: failuresQuery.data ?? NO_PLATFORM_FAILURES, isLoadError: failuresQuery.isError };
}

export function useFailuresDialog(hasFailures: boolean) {
  const [isFailuresDialogOpen, setFailuresDialogOpen] = React.useState(false);
  if (!hasFailures && isFailuresDialogOpen) setFailuresDialogOpen(false);
  return { isFailuresDialogOpen, setFailuresDialogOpen };
}
