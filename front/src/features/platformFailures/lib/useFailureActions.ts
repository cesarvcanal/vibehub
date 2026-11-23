import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { apiErrorMessage } from "@/lib/apiError";
import { t as translate } from "@/i18n";
import { writeLocation } from "@/features/board/lib/board";
import { Paths } from "@/lib/paths";
import { PLATFORM_FAILURES_KEY, platformFailuresApi } from "../api";

const LEAVE_ANIMATION_MS = 200;

export function useFailureActions(failureId: string, { leavesListOnSuccess }: { leavesListOnSuccess: boolean }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [isLeaving, setLeaving] = React.useState(false);
  const refreshFailures = () => void queryClient.invalidateQueries({ queryKey: PLATFORM_FAILURES_KEY });
  const leaveList = () => {
    if (!leavesListOnSuccess) return refreshFailures();
    setLeaving(true);
    setTimeout(refreshFailures, LEAVE_ANIMATION_MS);
  };
  const investigate = useMutation({
    mutationFn: () => platformFailuresApi.investigate(failureId),
    onSuccess: ({ card }) => {
      toast.success(translate("platformFailures.investigationStarted", { title: card.title }), {
        action: {
          label: translate("platformFailures.openInvestigationCard"),
          onClick: () => navigate(`${Paths.BOARD}?${writeLocation({ projectId: card.projectId, cardId: card.id })}`),
        },
      });
      leaveList();
    },
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  const dismiss = useMutation({
    mutationFn: () => platformFailuresApi.dismiss(failureId),
    onSuccess: leaveList,
    onError: (error) => toast.error(apiErrorMessage(error)),
  });
  return { investigate, dismiss, isBusy: investigate.isPending || dismiss.isPending, isLeaving };
}
