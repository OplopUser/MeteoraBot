import type { PendingRebalance } from "../domain.js";

function isRecoverableRpcSendFailure(pauseReason: string | null) {
  if (!pauseReason) {
    return false;
  }

  return (
    pauseReason.includes("Transaction confirmation timeout") ||
    pauseReason.includes("block height exceeded") ||
    pauseReason.includes("HTTP error (429)") ||
    pauseReason.includes("Too Many Requests")
  );
}

export function classifyCloseTimeout(previousPositionAddress: string | null, livePositionAddress: string | null) {
  if (!previousPositionAddress) {
    return "continue" as const;
  }

  return livePositionAddress && livePositionAddress === previousPositionAddress ? "retry" as const : "continue" as const;
}

export function classifySwapTimeout(needsSwap: boolean) {
  return needsSwap ? "retry" as const : "continue" as const;
}

export function classifyOpenTimeout(args: {
  livePositionAddress: string | null;
  previousPositionAddress: string | null;
  plannedPositionAddress: string | null;
}) {
  const { livePositionAddress, previousPositionAddress, plannedPositionAddress } = args;

  if (!livePositionAddress) {
    return "retry" as const;
  }

  if (plannedPositionAddress && livePositionAddress === plannedPositionAddress) {
    return "complete" as const;
  }

  if (!previousPositionAddress) {
    return "complete" as const;
  }

  return livePositionAddress !== previousPositionAddress ? "complete" as const : "retry" as const;
}

export function shouldRecoverPausedTimeout(pauseReason: string | null, pendingRebalance: PendingRebalance | null) {
  if (
    pendingRebalance?.recoveryReason?.startsWith("Ambiguous") &&
    !(
      pendingRebalance.phase === "opening" &&
      pauseReason?.includes("Ambiguous opening state after timeout") &&
      !pauseReason.includes("Multiple unclaimed positions")
    )
  ) {
    return false;
  }

  return isRecoverableRpcSendFailure(pauseReason);
}
