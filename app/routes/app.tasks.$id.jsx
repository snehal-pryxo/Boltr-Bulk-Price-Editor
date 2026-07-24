import { json } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useRevalidator,
  useSubmit,
} from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineStack,
  Layout,
  Modal,
  Page,
  Pagination,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { commitFlashSession, getFlashSession } from "../lib/flash.server";
import { withShopifyEmbeddedParams } from "../lib/shopify-embedded-url";
import {
  AUTO_REAPPLY_TEXT,
  formatAutoReapplyInterval,
  getAutoReapplyLastRun,
  getAutoReapplyNextRunAt,
  getDisabledAutoReapplyConfiguration,
  isAutoReapplyEnabled,
} from "../lib/task-auto-reapply";

const LOGS_PER_PAGE = 10;
const TASK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 500;
const ACTIVE_TASK_STATUSES = [
  "Pending",
  "Scheduled", // Added Scheduled to active statuses for polling
  "Applying",
  "Cancelling",
];
const SCHEDULED_LOG_PREVIEW_LIMIT = 250;

const SCHEDULED_PRODUCTS_QUERY = `#graphql
  query ScheduledTaskProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      nodes {
        id
        title
        handle
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const SCHEDULED_PRODUCT_NODES_QUERY = `#graphql
  query ScheduledTaskProductNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        id
        title
        handle
      }
      ... on ProductVariant {
        id
        title
        product {
          id
          title
          handle
        }
      }
    }
  }
`;

const SCHEDULED_COLLECTION_PRODUCTS_QUERY = `#graphql
  query ScheduledTaskCollectionProducts($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      products(first: $first, after: $after) {
        nodes {
          id
          title
          handle
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export const loader = async ({ request, params }) => {
  const { admin, session } = await authenticate.admin(request);
  const flashSession = await getFlashSession(request);
  const taskId = Number(params.id);
  const url = new URL(request.url);
  const selectedProductId = getShopifyNumericId(
    url.searchParams.get("productId"),
  );

  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Response("Task not found", { status: 404 });
  }

  let task = await db.task.findFirst({
    where: {
      id: taskId,
      shop: session.shop,
    },
  });

  if (!task) {
    throw new Response("Task not found", { status: 404 });
  }

  if (
    ACTIVE_TASK_STATUSES.includes(task.status) &&
    new Date(task.updatedAt).getTime() <
    Date.now() - TASK_EXECUTION_TIMEOUT_MS
  ) {
    await db.task.updateMany({
      where: { id: task.id, shop: session.shop },
      data: {
        status: "Cancelled",
        executionSummary: {
          ...(task.executionSummary || {}),
          ok: false,
          progress: 100,
          status: "Cancelled",
          error: "Task execution timed out before Shopify finished responding.",
        },
        completedAt: new Date(),
      },
    });
    task = await db.task.findFirst({
      where: {
        id: taskId,
        shop: session.shop,
      },
    });
  }

  const shopifyStoreHandle = getShopifyStoreHandle(session.shop);
  const shopCurrency =
    (
      await db.shop.findUnique({
        where: { shop: session.shop },
        select: { currency: true },
      })
    )?.currency || "";
  const selectedApplyCollections = isCollectionScope(task, "apply")
    ? await getSelectedCollectionDetails(admin, task, shopifyStoreHandle, "apply")
    : [];
  const selectedExcludeCollections = isCollectionScope(task, "exclude")
    ? await getSelectedCollectionDetails(admin, task, shopifyStoreHandle, "exclude")
    : [];
  const selectedApplyProducts = await getSelectedProductDetails(
    admin,
    task,
    shopifyStoreHandle,
    "apply",
  );
  const selectedExcludeProducts = await getSelectedProductDetails(
    admin,
    task,
    shopifyStoreHandle,
    "exclude",
  );
  const scheduledPreviewProducts = await getScheduledPreviewProducts(
    admin,
    task,
    selectedApplyProducts,
    shopifyStoreHandle,
  );

  return json({
    task,
    shop: session.shop,
    shopifyStoreHandle,
    selectedProductId,
    selectedCollections: selectedApplyCollections,
    selectedApplyCollections,
    selectedExcludeCollections,
    selectedApplyProducts,
    selectedExcludeProducts,
    scheduledPreviewProducts,
    productDetails: selectedProductId
      ? getProductDetails(
        task,
        selectedProductId,
        shopifyStoreHandle,
        shopCurrency,
      )
      : null,
    shopCurrency,
    toastMessage: flashSession.get("toast") || "",
  }, {
    headers: {
      "Set-Cookie": await commitFlashSession(flashSession),
    },
  });
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const flashSession = await getFlashSession(request);
  const taskId = Number(params.id);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (!Number.isInteger(taskId) || taskId <= 0) {
    throw new Response("Task not found", { status: 404 });
  }

  if (intent === "disable_auto_reapply") {
    const task = await db.task.findFirst({
      where: {
        id: taskId,
        shop: session.shop,
      },
    });

    if (!task) {
      throw new Response("Task not found", { status: 404 });
    }

    await db.task.updateMany({
      where: { id: task.id, shop: session.shop },
      data: {
        autoReapply: false,
        autoReapplyChanges: false,
        configuration: getDisabledAutoReapplyConfiguration(task.configuration),
        executionSummary: {
          ...(task.executionSummary || {}),
          autoReapplyDisabled: true,
          autoReapplyDisabledAt: new Date().toISOString(),
        },
      },
    });

    return json({ ok: true, disabledAutoReapply: true });
  }

  // New: Handle cancel_schedule intent
  if (intent === "cancel_schedule") {
    const task = await db.task.findFirst({
      where: {
        id: taskId,
        shop: session.shop,
      },
    });

    if (!task) {
      throw new Response("Task not found", { status: 404 });
    }

    if (!task.scheduleEnabled || task.scheduleStatus !== "pending") {
      return json(
        { ok: false, message: "Only pending scheduled tasks can be cancelled." },
        { status: 400 },
      );
    }

    const cancelledAt = new Date();
    await db.task.updateMany({
      where: { id: task.id, shop: session.shop, scheduleEnabled: true, scheduleStatus: "pending" },
      data: { status: "Cancelled", scheduleStatus: "cancelled", completedAt: cancelledAt, executionSummary: { ...(task.executionSummary || {}), status: "Cancelled", scheduleStatus: "cancelled", cancelledAt: cancelledAt.toISOString() } },
    });
    return json({ ok: true, cancelledSchedule: true });
  }

  if (intent === "delete") {
    await db.task.deleteMany({
      where: {
        id: taskId,
        shop: session.shop,
      },
    });

    flashSession.flash("toast", "Task deleted.");
    return json(
      { ok: true, deleted: true, message: "Task deleted." },
      {
        headers: {
          "Set-Cookie": await commitFlashSession(flashSession),
        },
      },
    );
  }

  return json({ ok: false, message: "Invalid action" }, { status: 400 });
};

function humanize(value) {
  if (!value) return "-";

  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeStatus(status) {
  return String(status || "").toLowerCase().trim();
}

function normalizeStatusKey(status) {
  return normalizeStatus(status).replace(/[\s-]+/g, "_");
}

function isFailedOrCanceledStatus(status) {
  const normalized = normalizeStatus(status);

  return (
    normalized.includes("failed") ||
    normalized.includes("error") ||
    (normalized.includes("cancel") &&
      !normalized.includes("canceling") &&
      !normalized.includes("cancelling"))
  );
}

function getCanceledStatusLabel(status) {
  const normalized = normalizeStatus(status);

  return normalized.includes("cancel") ||
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("rollback") ||
    normalized.includes("rolled back")
    ? "Cancelled"
    : humanize(status);
}

function normalizeScheduleStatus(task) {
  return String(task?.scheduleStatus || "").toLowerCase().trim();
}

function isScheduledTask(task) {
  return Boolean(task?.scheduleEnabled || task?.isScheduled);
}

function isPendingScheduledTask(task) {
  return isScheduledTask(task) && normalizeScheduleStatus(task) === "pending";
}

function isRunningScheduledTask(task) {
  return isScheduledTask(task) && normalizeScheduleStatus(task) === "running";
}

function formatDate(value) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTime(value) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatRelativeTime(value) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  const diffSeconds = Math.max(
    0,
    Math.round((Date.now() - date.getTime()) / 1000),
  );

  if (diffSeconds < 45) return "just now";

  const minutes = Math.round(diffSeconds / 60);
  if (minutes < 2) return "about 1 minute ago";
  if (minutes < 45) return `about ${minutes} minutes ago`;
  if (minutes < 90) return "about 1 hour ago";

  const hours = Math.round(minutes / 60);
  if (hours < 22) return `about ${hours} hours ago`;
  if (hours < 36) return "about 1 day ago";

  const days = Math.round(hours / 24);
  if (days < 26) return `about ${days} days ago`;
  if (days < 45) return "about 1 month ago";

  const months = Math.round(days / 30);
  if (months < 12) return `about ${months} months ago`;

  const years = Math.round(days / 365);
  return years <= 1 ? "about 1 year ago" : `about ${years} years ago`;
}

function formatAutoReapplyRemainingTime(value, nowMs = Date.now()) {
  if (!value) return "";

  const nextRunAt = new Date(value).getTime();
  if (Number.isNaN(nextRunAt)) return "";

  const diffSeconds = Math.max(0, Math.ceil((nextRunAt - nowMs) / 1000));
  if (diffSeconds <= 0) return "on next cron check";
  if (diffSeconds < 60) return "in less than 1 minute";

  const minutes = Math.ceil(diffSeconds / 60);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (!remainingMinutes) return `in ${hours} hour${hours === 1 ? "" : "s"}`;

  return `in ${hours} hour${hours === 1 ? "" : "s"} ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`;
}

function getTaskChangeItems(task, shopCurrency = "") {
  const currencyCode =
    String(task.applyChangesTo || "").toLowerCase() === "markets"
      ? getMarketCurrencyLabel(task)
      : shopCurrency;
  const changes = [
    formatChangePayload(task.priceChange, "price", currencyCode),
    formatChangePayload(task.compareAtPriceChange, "compare at price", currencyCode),
    formatChangePayload(task.costPerItemChange, "cost per item"),
  ].filter(Boolean);

  return changes;
}

function getDiscountedScopeValue(task) {
  return (
    task.discountedScope ||
    task.excludeResources?.discountedScope ||
    task.configuration?.exclude_discounted ||
    task.configuration?.discounted_exclusion_scope ||
    "nothing"
  );
}

function formatDiscountedScope(task) {
  const scope = String(getDiscountedScopeValue(task) || "").toLowerCase();

  if (
    scope === "nothing" ||
    scope === "none" ||
    scope === "no" ||
    scope === "false"
  ) {
    return "Nothing";
  }

  if (scope === "products_on_sale") return "Products on sale";
  if (scope === "variants_on_sale") return "Product variants on sale";
  if (scope === "product_types_on_sale") return "Product types on sale";

  return humanize(scope);
}

function ChangeDetails({ task, shopCurrency = "" }) {
  const autoReapplyLastRun = getAutoReapplyLastRun(task);
  const autoReapplyNextRunAt = getAutoReapplyNextRunAt(task);
  const showAutoReapply = isAutoReapplyEnabled(task);
  const autoReapplyIntervalText = formatAutoReapplyInterval(task);
  const changes = getTaskChangeItems(task, shopCurrency);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!showAutoReapply || !autoReapplyNextRunAt) return undefined;

    const timer = setInterval(() => setNowMs(Date.now()), 60 * 1000);
    return () => clearInterval(timer);
  }, [showAutoReapply, autoReapplyNextRunAt]);

  return (
    <BlockStack gap="150">
      {(changes.length ? changes : ["Change"]).map((change, index) => (
        <Text as="p" fontWeight="regular" key={`task-change-${index}`}>
          {change}
        </Text>
      ))}

      {showAutoReapply && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            marginTop: "8px",
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M1.5 7.25a.75.75 0 0 0 1.5 0 3 3 0 0 1 3-3h6.566l-1.123 1.248a.75.75 0 1 0 1.115 1.004l2.25-2.5a.75.75 0 0 0-.028-1.032l-2.25-2.25a.749.749 0 1 0-1.06 1.06l.97.97h-6.44a4.5 4.5 0 0 0-4.5 4.5" />
            <path d="M14.5 8.75a.75.75 0 0 0-1.5 0 3 3 0 0 1-3 3h-6.566l1.123-1.248a.75.75 0 1 0-1.115-1.004l-2.25 2.5a.75.75 0 0 0 .028 1.032l2.25 2.25a.749.749 0 1 0 1.06-1.06l-.97-.97h6.44a4.5 4.5 0 0 0 4.5-4.5" />
          </svg>

          <Text as="p" tone="subdued">
            {AUTO_REAPPLY_TEXT} - {autoReapplyIntervalText}
          </Text>
        </div>
      )}

      {showAutoReapply && autoReapplyLastRun ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            marginTop: "2px",
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m8.75-3.25a.75.75 0 0 0-1.5 0v3.5c0 .199.079.39.22.53l2.25 2.25a.75.75 0 1 0 1.06-1.06L8.75 7.94z" />
          </svg>

          <Text as="p" tone="subdued">
            Last run {formatRelativeTime(autoReapplyLastRun)}
          </Text>
        </div>
      ) : null}

      {showAutoReapply && autoReapplyNextRunAt ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            marginTop: "2px",
          }}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 16 16"
            width="16"
            height="16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m8.75-3.25a.75.75 0 0 0-1.5 0v3.5c0 .199.079.39.22.53l2.25 2.25a.75.75 0 1 0 1.06-1.06L8.75 7.94z" />
          </svg>

          <Text as="p" tone="subdued">
            Next run {formatAutoReapplyRemainingTime(autoReapplyNextRunAt, nowMs)}
          </Text>
        </div>
      ) : null}
    </BlockStack>
  );
}

function getTaskMarkets(task) {
  const markets = Array.isArray(task.selectedMarkets)
    ? task.selectedMarkets
    : Array.isArray(task.markets)
      ? task.markets
      : [];

  return markets.filter((market) => market?.id || market?.name || market?.label);
}

function formatMarketLabel(market) {
  const name = market?.name || market?.label || "Market";
  const currencyCode =
    market?.currencyCode ||
    market?.currencySettings?.baseCurrency?.currencyCode ||
    "";

  return `${name}${currencyCode ? ` (${currencyCode})` : ""}`;
}

function getMarketCurrencyCodes(task) {
  const currencies = [
    ...new Set(
      getTaskMarkets(task)
        .flatMap((market) => [
          market.currencyCode,
          market.currencySettings?.baseCurrency?.currencyCode,
          ...(Array.isArray(market.priceLists)
            ? market.priceLists.map((priceList) => priceList.currencyCode)
            : []),
        ])
        .filter(Boolean),
    ),
  ];

  return currencies;
}

function getMarketCurrencyLabel(task) {
  return getMarketCurrencyCodes(task).join(" / ");
}

function formatChangePayload(change, label, currencyCode = "") {
  const action = String(change?.action || "").toLowerCase();
  if (!action) return "";

  if (action === "reset_compare_at_price") return "Reset compare at price";
  if (action === "reset_cost_per_item") return "Reset cost per item";
  if (action === "set_to_price") return "Set compare at price to price";
  if (action === "set_to_compare_at_price") {
    return "Set price to compare at price";
  }
  if (action === "set_margin") {
    return change.percent
      ? `Set ${label} margin to ${change.percent}%`
      : `Set ${label} margin`;
  }

  const actionLabel =
    action === "increase"
      ? "Increase"
      : action === "decrease"
        ? "Decrease"
        : action === "set_new_value"
          ? "Set"
          : humanize(action);

  const value =
    change.type === "by_amount"
      ? `${change.amount || ""}${currencyCode && change.amount ? ` ${currencyCode}` : ""}`
      : change.percent
        ? `${change.percent}%`
        : change.amount;

  if (action === "set_new_value") {
    const suffix = value && currencyCode ? ` ${currencyCode}` : "";
    return value ? `Set ${label} to ${value}${suffix}` : `Set ${label}`;
  }

  const valueText = value ? ` by ${value}` : "";

  return `${actionLabel} ${label}${valueText}`;
}

function getNumberValue(...values) {
  const foundValue = values
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value));

  return Number.isFinite(foundValue) ? foundValue : null;
}

function getExecutionProgress(task) {
  const progress = getNumberValue(
    task.progress,
    task.percent,
    task.percentage,
    task.executionProgress,
    task.executionPercent,
    task.executionSummary?.progress,
    task.executionSummary?.percent,
    task.executionSummary?.percentage,
  );

  if (Number.isFinite(progress)) {
    return Math.max(0, Math.min(100, Math.round(progress)));
  }

  return 0;
}

function getTaskProgressStartedAt(task) {
  return (
    task.executionSummary?.processingStartedAt ||
    task.executionSummary?.startedAt ||
    task.startedAt ||
    task.createdAt ||
    ""
  );
}

function getLiveApplyingProgress(task, currentProgress, nowMs) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(currentProgress) || 0)));

  if (!isTaskProcessing(task) || progress >= 100) {
    return progress;
  }

  const startedAt = Date.parse(getTaskProgressStartedAt(task));
  if (!Number.isFinite(startedAt)) {
    return progress;
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  if (elapsedSeconds < 2) {
    return Math.max(progress, 1);
  }

  const elapsedStep = Math.min(90, Math.floor(elapsedSeconds / 2) * 10);
  const liveProgress = Math.max(10, elapsedStep);

  return Math.max(progress, Math.min(90, liveProgress));
}

function getTaskRollbackStartedAt(task) {
  return (
    task.executionSummary?.rollback?.startedAt ||
    task.executionSummary?.rollbackSummary?.startedAt ||
    task.executionSummary?.rollbackStartedAt ||
    task.rollback?.startedAt ||
    task.rollbackSummary?.startedAt ||
    ""
  );
}

function getLiveCancellingProgress(task, currentProgress, nowMs) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(currentProgress) || 0)));

  if (progress >= 100) {
    return 100;
  }

  const startedAt = Date.parse(getTaskRollbackStartedAt(task));
  if (!Number.isFinite(startedAt)) {
    return Math.max(progress, 1);
  }

  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedAt) / 1000));
  if (elapsedSeconds < 2) {
    return Math.max(progress, 1);
  }

  const elapsedStep = Math.min(90, Math.floor(elapsedSeconds / 2) * 10);
  const liveProgress = Math.max(10, elapsedStep);

  return Math.max(progress, Math.min(90, liveProgress));
}

function getTaskCompletedValue(task) {
  return (
    task.completedAt ||
    task.appliedAt ||
    task.executionSummary?.completedAt ||
    task.executionSummary?.appliedAt ||
    task.executionSummary?.finishedAt ||
    task.executionSummary?.completed ||
    ""
  );
}

function getTaskStatusValue(task) {
  return (
    task.status ||
    task.executionStatus ||
    task.executionSummary?.status ||
    task.executionSummary?.taskStatus ||
    ""
  );
}

function isTaskCompleted(task) {
  const status = normalizeStatus(getTaskStatusValue(task));

  if (isFailedOrCanceledStatus(status)) return false;

  const executionProgress = getExecutionProgress(task);
  const completedValue = getTaskCompletedValue(task);

  return (
    Boolean(completedValue) ||
    executionProgress >= 100 ||
    status === "complete" ||
    status === "completed" ||
    status === "applied" ||
    status === "done" ||
    status === "success" ||
    status === "successful"
  );
}

function isTaskFailed(task) {
  return isFailedOrCanceledStatus(getTaskStatusValue(task));
}

function isTaskProcessing(task) {
  const status = normalizeStatus(getTaskStatusValue(task));

  if (isTaskCompleted(task) || isTaskFailed(task)) return false;

  return (
    status === "applying"
  );
}

function isTaskPending(task) {
  const status = normalizeStatus(getTaskStatusValue(task));

  return !isTaskCompleted(task) && !isTaskFailed(task) && status === "pending";
}

function getBaseTaskDisplay(task) {
  const status = getTaskStatusValue(task);
  const normalized = normalizeStatus(status);

  // Prioritize scheduled status
  if (isPendingScheduledTask(task)) {
    return {
      label: "Schedule",
      tone: "info",
      background: "#E0F2FE",
      showPendingSpinner: false,
      showProgress: false,
      style: {
        width: "fit-content",
      },
    };
  }
  if (isTaskFailed(task)) {
    return {
      label: getCanceledStatusLabel(status),
      tone: "critical",
      background: "#FEE4E2",
      showProgress: false,
      style: {
        width: "fit-content",
      },
    };
  }

  if (isTaskCompleted(task)) {
    return {
      label: "Completed",
      tone: "success",
      background: "#D1FADF",
      showProgress: false,
      style: {
        width: "fit-content",
      },
    };
  }

  if (isTaskPending(task) || !normalized) {
    return {
      label: "Pending",
      tone: "attention",
      background: "#FEDF89",
      progress: getExecutionProgress(task),
      showPendingSpinner: true,
      showProgress: false,
      style: {
        width: "fit-content",
      },
    };
  }

  if (isTaskProcessing(task)) {
    return {
      label: "Applying",
      tone: "attention",
      background: "#FEDF89",
      progress: getExecutionProgress(task),
      showPendingSpinner: true,
      showProgress: true,
      style: {
        width: "fit-content",
      },
    };
  }

  if (!normalized) {
    return {
      label: "Pending",
      tone: "attention",
      background: "#FEDF89",
      showPendingSpinner: true,
      showProgress: false,
      style: {
        width: "fit-content",
      },
    };
  }

  return {
    label: humanize(status),
    tone: "info",
    background: "#E0F2FE",
    showProgress: false,
    style: {
      width: "fit-content",
    },
  };
}

function getRollbackStatusValue(task) {
  return (
    task.rollbackStatus ||
    task.rollback?.status ||
    task.rollbackSummary?.status ||
    task.executionSummary?.rollbackStatus ||
    task.executionSummary?.rollback?.status ||
    task.executionSummary?.rollbackSummary?.status ||
    ""
  );
}

function getRollbackStartedValue(task) {
  return (
    task.rollbackStartedAt ||
    task.rollback?.startedAt ||
    task.rollbackSummary?.startedAt ||
    task.executionSummary?.rollbackStartedAt ||
    task.executionSummary?.rollback?.startedAt ||
    task.executionSummary?.rollbackSummary?.startedAt ||
    ""
  );
}

function getRollbackCompletedValue(task) {
  return (
    task.rollbackCompletedAt ||
    task.rolledBackAt ||
    task.rollback?.completedAt ||
    task.rollbackSummary?.completedAt ||
    task.executionSummary?.rollbackCompletedAt ||
    task.executionSummary?.rolledBackAt ||
    task.executionSummary?.rollback?.completedAt ||
    task.executionSummary?.rollbackSummary?.completedAt ||
    ""
  );
}

function getRollbackProgress(task) {
  const progress = getNumberValue(
    task.rollbackProgress,
    task.rollbackPercent,
    task.rollbackPercentage,
    task.rollback?.progress,
    task.rollback?.percent,
    task.rollbackSummary?.progress,
    task.rollbackSummary?.percent,
    task.rollbackSummary?.percentage,
    task.executionSummary?.rollbackProgress,
    task.executionSummary?.rollbackPercent,
    task.executionSummary?.rollbackPercentage,
    task.executionSummary?.rollback?.progress,
    task.executionSummary?.rollback?.percent,
    task.executionSummary?.rollbackSummary?.progress,
    task.executionSummary?.rollbackSummary?.percent,
    task.executionSummary?.rollbackSummary?.percentage,
  );

  if (Number.isFinite(progress)) {
    return Math.max(0, Math.min(100, Math.round(progress)));
  }

  return 0;
}

function getRollbackSummary(task) {
  return (
    task.rollback ||
    task.rollbackSummary ||
    task.executionSummary?.rollback ||
    task.executionSummary?.rollbackSummary ||
    {}
  );
}

function getRollbackState(task) {
  const taskStatus = normalizeStatus(getTaskStatusValue(task));
  const rollbackStatus = normalizeStatus(getRollbackStatusValue(task));
  const taskStatusKey = normalizeStatusKey(getTaskStatusValue(task));
  const rollbackStatusKey = normalizeStatusKey(getRollbackStatusValue(task));
  const rollbackProgress = getRollbackProgress(task);
  const rollbackSummary = getRollbackSummary(task);

  const hasStartedAt = Boolean(getRollbackStartedValue(task));
  const hasCompletedAt = Boolean(getRollbackCompletedValue(task));
  const hasSuccessfulRollback =
    rollbackSummary?.ok === true &&
    (rollbackProgress >= 100 ||
      Boolean(rollbackSummary.completedAt) ||
      Boolean(rollbackSummary.rolledBackAt));

  const completedStatuses = ["cancelled", "canceled"];

  const processingStatuses = ["canceling", "cancelling"];

  const failedStatuses = ["failed", "error", "cancelled", "canceled"];

  const isCompleted =
    hasCompletedAt ||
    hasSuccessfulRollback ||
    completedStatuses.includes(rollbackStatusKey) ||
    ((taskStatusKey === "cancelled" || taskStatusKey === "canceled") &&
      rollbackSummary?.ok === true) ||
    taskStatus.includes("rolled back") ||
    taskStatus.includes("rollback complete");

  const isFailed =
    !isCompleted &&
    (failedStatuses.some((status) => rollbackStatus.includes(status)) ||
      failedStatuses.some((status) => rollbackStatusKey.includes(status)) ||
      taskStatusKey.includes("rollback_failed") ||
      taskStatus.includes("rollback failed"));

  const hasRealRollbackStart =
    hasStartedAt ||
    rollbackProgress > 0 ||
    processingStatuses.includes(rollbackStatusKey) ||
    processingStatuses.includes(taskStatusKey);

  const isProcessing =
    !isCompleted &&
    !isFailed &&
    hasRealRollbackStart;

  return {
    isCompleted,
    isProcessing,
    isFailed,
    progress: rollbackProgress,
  };
}

function getStatusToneFromDisplay(display) {
  return display?.tone || "info";
}

function getDetailsStatusDisplay(task, rollbackState = null) {
  if (rollbackState?.isCompleted) {
    return {
      label: "Cancelled",
      tone: "success",
      background: "#D1FADF",
      showProgress: false,
    };
  }

  if (rollbackState?.isProcessing) {
    return {
      label: "Cancelling",
      tone: "attention",
      background: "#FEDF89",
      progress: rollbackState.progress,
      showPendingSpinner: true,
      showProgress: true,
    };
  }

  if (rollbackState?.isFailed) {
    return {
      label: getCanceledStatusLabel(
        getRollbackStatusValue(task) || getTaskStatusValue(task) || "Cancel",
      ),
      tone: "critical",
      background: "rgb(185, 184, 184)",
      showProgress: false,
    };
  }

  if (isTaskCompleted(task)) {
    return {
      label: "Completed",
      tone: "success",
      background: "#D1FADF",
      showProgress: false,
    };
  }

  return getBaseTaskDisplay(task);
}

function getLogStatusLabel(task, statusDisplay, rollbackState = null) {
  if (rollbackState?.isProcessing || rollbackState?.isFailed || rollbackState?.isCompleted) {
    return statusDisplay.label;
  }

  if (isTaskProcessing(task)) return statusDisplay.label;
  if (isTaskCompleted(task)) return "Completed";
  if (isTaskFailed(task)) return getCanceledStatusLabel(getTaskStatusValue(task));

  return humanize(getTaskStatusValue(task) || "Pending");
}

function getShopifyStoreHandle(shop) {
  if (!shop) return "";

  return String(shop)
    .replace(/^https?:\/\//, "")
    .replace(".myshopify.com", "")
    .split("/")[0]
    .trim();
}

function getShopifyNumericId(value) {
  if (!value) return "";

  const stringValue = String(value);
  const gidMatch = stringValue.match(/\/(\d+)$/);
  if (gidMatch?.[1]) return gidMatch[1];

  const numberMatch = stringValue.match(/^(\d+)$/);
  if (numberMatch?.[1]) return numberMatch[1];

  return stringValue;
}

function getProductId(record) {
  return getShopifyNumericId(
    record?.productId ??
    record?.product_id ??
    record?.legacyProductId ??
    record?.productLegacyResourceId ??
    record?.productGraphqlId ??
    record?.productGid ??
    record?.product?.id ??
    record?.product?.legacyResourceId ??
    record?.product?.admin_graphql_api_id,
  );
}

function getVariantId(record) {
  return getShopifyNumericId(
    record?.variantId ??
    record?.variant_id ??
    record?.legacyVariantId ??
    record?.variantLegacyResourceId ??
    record?.variantGraphqlId ??
    record?.variantGid ??
    record?.admin_graphql_api_id ??
    record?.variant?.id ??
    record?.variant?.legacyResourceId ??
    record?.id,
  );
}

function getProductTitle(record) {
  return (
    record?.productTitle ||
    record?.product?.title ||
    record?.title ||
    "Product"
  );
}

function getVariantTitle(record) {
  return (
    record?.variantTitle ||
    record?.variant?.title ||
    record?.optionTitle ||
    record?.selectedOptionsTitle ||
    record?.title ||
    "Default Title"
  );
}

function getVariantSku(record) {
  return record?.sku || record?.variant?.sku || "-";
}

function getProductAdminUrl(shopifyStoreHandle, productId) {
  if (!shopifyStoreHandle || !productId) return "";

  return `https://admin.shopify.com/store/${shopifyStoreHandle}/products/${productId}`;
}

function getVariantAdminUrl(shopifyStoreHandle, productId, variantId) {
  if (!shopifyStoreHandle || !productId || !variantId) return "";

  return `https://admin.shopify.com/store/${shopifyStoreHandle}/products/${productId}/variants/${variantId}`;
}

function getCollectionAdminUrl(shopifyStoreHandle, collectionId) {
  if (!shopifyStoreHandle || !collectionId) return "";

  return `https://admin.shopify.com/store/${shopifyStoreHandle}/collections/${collectionId}`;
}

function isCollectionScope(task, prefix = "") {
  const values = [
    prefix === "exclude" ? task?.excludeScope : task?.applyScope,
    prefix === "exclude" ? task?.excludeResources?.scope : task?.applyResources?.scope,
    !prefix ? task?.scope : "",
    !prefix ? task?.targetScope : "",
    !prefix ? task?.selectionScope : "",
    !prefix ? task?.applyTo?.scope : "",
    !prefix ? task?.selection?.scope : "",
    !prefix ? task?.target?.scope : "",
    prefix === "exclude"
      ? task?.executionSummary?.excludeScope
      : task?.executionSummary?.applyScope,
    prefix === "exclude"
      ? task?.executionSummary?.excludeResources?.scope
      : task?.executionSummary?.applyResources?.scope,
    !prefix ? task?.executionSummary?.scope : "",
    !prefix ? task?.executionSummary?.targetScope : "",
    !prefix ? task?.executionSummary?.selectionScope : "",
    !prefix ? task?.executionSummary?.applyTo?.scope : "",
    !prefix ? task?.executionSummary?.selection?.scope : "",
    !prefix ? task?.executionSummary?.target?.scope : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return values.includes("collection");
}

function isPlaceholderCollectionTitle(title, collectionId = "") {
  const normalizedTitle = String(title || "").trim().toLowerCase();
  const normalizedId = String(collectionId || "").trim().toLowerCase();

  if (!normalizedTitle) return true;
  if (normalizedId && normalizedTitle === `collection ${normalizedId}`) return true;

  return /^collection\s+\d+$/i.test(normalizedTitle);
}

function readJsonField(value) {
  if (!value || typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function getArrayValue(value) {
  const parsed = readJsonField(value);

  if (Array.isArray(parsed)) return parsed;
  if (parsed === undefined || parsed === null || parsed === "") return [];

  return [parsed];
}

function getConfigArray(configuration, name) {
  const value = configuration?.[name];
  return getArrayValue(value);
}

function buildCollectionRecordsFromIds(ids, titles = [], handles = [], counts = [], imageUrls = []) {
  return getArrayValue(ids)
    .map((id, index) => ({
      id,
      title: getArrayValue(titles)[index] || "",
      handle: getArrayValue(handles)[index] || "",
      productsCount: getArrayValue(counts)[index] || "",
      imageUrl: getArrayValue(imageUrls)[index] || "",
    }))
    .filter((record) => record.id || record.title || record.handle);
}

function getCollectionRecordId(record) {
  if (!record) return "";

  if (typeof record === "string" || typeof record === "number") {
    return getShopifyNumericId(record);
  }

  return getShopifyNumericId(
    record?.collectionId ??
    record?.collection_id ??
    record?.legacyResourceId ??
    record?.legacy_resource_id ??
    record?.legacyCollectionId ??
    record?.collectionLegacyResourceId ??
    record?.admin_graphql_api_id ??
    record?.collectionGid ??
    record?.gid ??
    record?.resourceId ??
    record?.resource_id ??
    record?.targetId ??
    record?.target_id ??
    record?.value ??
    record?.id,
  );
}

function getCollectionRecordGid(record) {
  const rawValue =
    typeof record === "object" && record
      ? record.collectionGid ||
      record.gid ||
      record.admin_graphql_api_id ||
      record.resourceId ||
      record.targetId ||
      record.value ||
      record.id
      : record;

  const stringValue = String(rawValue || "");
  if (stringValue.includes("gid://shopify/Collection/")) return stringValue;

  const collectionId = getCollectionRecordId(record);
  return collectionId ? `gid://shopify/Collection/${collectionId}` : "";
}

function getProductRecordGid(record) {
  const rawValue =
    typeof record === "object" && record
      ? record.productGid ||
      record.gid ||
      record.admin_graphql_api_id ||
      record.resourceId ||
      record.targetId ||
      record.value ||
      record.productId ||
      record.id
      : record;

  const stringValue = String(rawValue || "");
  if (stringValue.includes("gid://shopify/Product/")) return stringValue;

  const productId = getShopifyNumericId(rawValue);
  return productId ? `gid://shopify/Product/${productId}` : "";
}

function getCollectionRecordHandle(record) {
  if (!record || typeof record !== "object") return "";

  return (
    record?.handle ||
    record?.collectionHandle ||
    record?.collection_handle ||
    record?.resourceHandle ||
    record?.targetHandle ||
    ""
  );
}

function getCollectionRecordTitle(record, collectionId = "") {
  if (!record) return "";

  if (typeof record === "string") {
    const trimmed = record.trim();
    const numericId = getShopifyNumericId(trimmed);

    if (
      trimmed.includes("gid://shopify/Collection/") ||
      trimmed === numericId
    ) {
      return "";
    }

    return trimmed;
  }

  return (
    record?.title ||
    record?.name ||
    record?.collectionTitle ||
    record?.collection_title ||
    record?.displayName ||
    record?.label ||
    record?.text ||
    record?.handle ||
    record?.collectionHandle ||
    ""
  );
}

function normalizeCollectionRecord(record, index = 0) {
  const parsedRecord = readJsonField(record);
  const collectionId = getCollectionRecordId(parsedRecord);
  const gid = getCollectionRecordGid(parsedRecord);
  const title = getCollectionRecordTitle(parsedRecord, collectionId);
  const handle = getCollectionRecordHandle(parsedRecord);

  return {
    key: gid || collectionId || handle || title || `collection-${index}`,
    id: collectionId,
    gid,
    title,
    handle,
    raw: parsedRecord,
  };
}

function getSelectedCollectionRecords(task, prefix = "apply") {
  if (!isCollectionScope(task, prefix)) return [];

  const configuration = task.configuration || {};
  const resources =
    prefix === "exclude" ? task.excludeResources || {} : task.applyResources || {};
  const summary = task.executionSummary || {};
  const summaryResources =
    prefix === "exclude"
      ? summary.excludeResources || summary.input?.excludeResources || {}
      : summary.applyResources || summary.input?.applyResources || {};
  const summaryConfiguration = summary.configuration || summary.input?.configuration || {};

  const records = [
    ...getArrayValue(resources.collections),
    ...getArrayValue(resources.selectedCollections),
    ...buildCollectionRecordsFromIds(
      resources.collectionIds,
      resources.collectionTitles,
      resources.collectionHandles,
      resources.collectionProductsCounts,
      resources.collectionImageUrls,
    ),
    ...getArrayValue(summaryResources.collections),
    ...getArrayValue(summaryResources.selectedCollections),
    ...buildCollectionRecordsFromIds(
      summaryResources.collectionIds,
      summaryResources.collectionTitles,
      summaryResources.collectionHandles,
      summaryResources.collectionProductsCounts,
      summaryResources.collectionImageUrls,
    ),
    ...buildCollectionRecordsFromIds(
      getConfigArray(configuration, `${prefix}_collection_ids[]`),
      getConfigArray(configuration, `${prefix}_collection_titles[]`),
      getConfigArray(configuration, `${prefix}_collection_handles[]`),
      getConfigArray(configuration, `${prefix}_collection_products_counts[]`),
      getConfigArray(configuration, `${prefix}_collection_image_urls[]`),
    ),
    ...buildCollectionRecordsFromIds(
      getConfigArray(summaryConfiguration, `${prefix}_collection_ids[]`),
      getConfigArray(summaryConfiguration, `${prefix}_collection_titles[]`),
      getConfigArray(summaryConfiguration, `${prefix}_collection_handles[]`),
      getConfigArray(summaryConfiguration, `${prefix}_collection_products_counts[]`),
      getConfigArray(summaryConfiguration, `${prefix}_collection_image_urls[]`),
    ),
  ].filter(Boolean);

  const unique = new Map();

  records.forEach((record, index) => {
    const collection = normalizeCollectionRecord(record, index);
    const rawRecord = collection.raw;
    const rawType =
      typeof rawRecord === "object" && rawRecord
        ? String(rawRecord.type || rawRecord.resourceType || rawRecord.targetType || "").toLowerCase()
        : "";

    if (
      rawType &&
      !rawType.includes("collection") &&
      (rawType.includes("product") ||
        rawType.includes("variant") ||
        rawType.includes("inventory"))
    ) {
      return;
    }

    const hasRealTitle = !isPlaceholderCollectionTitle(
      collection.title,
      collection.id,
    );

    if (!collection.id && !collection.gid && !collection.handle && !hasRealTitle) {
      return;
    }

    const key = collection.gid || collection.id || collection.handle || collection.title;

    if (!unique.has(key)) {
      unique.set(key, collection.raw);
    }
  });

  return Array.from(unique.values());
}

function escapeShopifySearchValue(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .trim();
}

async function fetchCollectionByText(admin, collection) {
  if (!admin?.graphql) return null;

  const title = collection.title && !collection.title.startsWith("Collection ")
    ? collection.title
    : "";
  const handle = collection.handle || "";

  if (!title && !handle) return null;

  const queryText = handle
    ? `handle:${escapeShopifySearchValue(handle)}`
    : `title:'${escapeShopifySearchValue(title)}'`;

  try {
    const response = await admin.graphql(
      `#graphql
      query CollectionByText($query: String!) {
        collections(first: 1, query: $query) {
          nodes {
            id
            title
            handle
            legacyResourceId
          }
        }
      }`,
      { variables: { query: queryText } },
    );
    const payload = await response.json();
    return payload?.data?.collections?.nodes?.[0] || null;
  } catch (error) {
    console.error("Failed to search selected collection:", error);
    return null;
  }
}

async function getSelectedCollectionDetails(admin, task, shopifyStoreHandle, prefix = "apply") {
  const records = getSelectedCollectionRecords(task, prefix);

  if (!records.length) return [];

  const collectionMap = new Map();

  records.forEach((record, index) => {
    const collection = normalizeCollectionRecord(record, index);
    const hasRealTitle = !isPlaceholderCollectionTitle(collection.title, collection.id);

    collectionMap.set(collection.key, {
      ...collection,
      title: hasRealTitle ? collection.title : "",
      verified: false,
      adminUrl: getCollectionAdminUrl(shopifyStoreHandle, collection.id),
    });
  });

  const idsToFetch = Array.from(
    new Set(
      Array.from(collectionMap.values())
        .filter((collection) => collection.gid)
        .map((collection) => collection.gid),
    ),
  );

  if (idsToFetch.length && admin?.graphql) {
    try {
      const response = await admin.graphql(
        `#graphql
        query SelectedCollections($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Collection {
              id
              title
              handle
              legacyResourceId
            }
          }
        }`,
        { variables: { ids: idsToFetch } },
      );
      const payload = await response.json();
      const nodes = payload?.data?.nodes || [];
      const foundGids = new Set();

      nodes.forEach((node) => {
        if (!node?.id) return;

        foundGids.add(node.id);

        const collectionId = getShopifyNumericId(node.legacyResourceId || node.id);
        const existingKey = node.id || collectionId;
        const gidKey = `gid://shopify/Collection/${collectionId}`;
        const current =
          collectionMap.get(existingKey) ||
          collectionMap.get(collectionId) ||
          collectionMap.get(gidKey) ||
          {};

        collectionMap.set(existingKey, {
          ...current,
          key: existingKey,
          id: collectionId,
          gid: node.id,
          title: node.title || node.handle || `Collection ${collectionId}`,
          handle: node.handle || current.handle || "",
          verified: true,
          adminUrl: getCollectionAdminUrl(shopifyStoreHandle, collectionId),
        });

        if (collectionId && collectionMap.has(collectionId)) {
          collectionMap.delete(collectionId);
        }
        if (gidKey !== existingKey && collectionMap.has(gidKey)) {
          collectionMap.delete(gidKey);
        }
      });

      Array.from(collectionMap.entries()).forEach(([key, collection]) => {
        if (collection.gid && !foundGids.has(collection.gid) && !collection.title && !collection.handle) {
          collectionMap.delete(key);
        }
      });
    } catch (error) {
      console.error("Failed to load selected collection details:", error);
    }
  }

  for (const [key, collection] of Array.from(collectionMap.entries())) {
    if (collection.verified || collection.id || !admin?.graphql) continue;
    if (!collection.title && !collection.handle) {
      collectionMap.delete(key);
      continue;
    }

    const node = await fetchCollectionByText(admin, collection);
    if (!node?.id) {
      if (!collection.title || isPlaceholderCollectionTitle(collection.title, collection.id)) {
        collectionMap.delete(key);
      }
      continue;
    }

    const collectionId = getShopifyNumericId(node.legacyResourceId || node.id);
    collectionMap.set(key, {
      ...collection,
      id: collectionId,
      gid: node.id,
      title: node.title || collection.title || node.handle || `Collection ${collectionId}`,
      handle: node.handle || collection.handle || "",
      verified: true,
      adminUrl: getCollectionAdminUrl(shopifyStoreHandle, collectionId),
    });
  }

  return Array.from(collectionMap.values()).filter((collection) => {
    const hasRealTitle = !isPlaceholderCollectionTitle(collection.title, collection.id);

    if (collection.verified) return true;
    if (collection.handle) return true;

    return hasRealTitle;
  });
}

async function getSelectedProductDetails(admin, task, shopifyStoreHandle, prefix = "apply") {
  const records = getSelectedResourceRecords(task, prefix, "product");

  if (!records.length) return [];

  const productMap = new Map();

  records.forEach((record, index) => {
    const source =
      typeof record === "object" && record !== null
        ? record
        : { id: record };
    const productId = getShopifyNumericId(source.productId || source.gid || source.id);
    const gid = getProductRecordGid(record);
    const key = gid || productId || source.title || `product-${index}`;

    if (!productMap.has(key)) {
      productMap.set(key, {
        ...source,
        key,
        id: productId,
        gid,
        title: source.title || source.productTitle || "",
        handle: source.handle || "",
        adminUrl: getProductAdminUrl(shopifyStoreHandle, productId),
      });
    }
  });

  const idsToFetch = Array.from(
    new Set(
      Array.from(productMap.values())
        .filter((product) => product.gid)
        .map((product) => product.gid),
    ),
  );

  if (idsToFetch.length && admin?.graphql) {
    try {
      const response = await admin.graphql(
        `#graphql
        query SelectedProducts($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product {
              id
              title
              handle
              legacyResourceId
            }
          }
        }`,
        { variables: { ids: idsToFetch } },
      );
      const payload = await response.json();
      const nodes = payload?.data?.nodes || [];

      nodes.forEach((node) => {
        if (!node?.id) return;

        const productId = getShopifyNumericId(node.legacyResourceId || node.id);
        const gidKey = node.id;
        const numericKey = productId;
        const current =
          productMap.get(gidKey) ||
          productMap.get(numericKey) ||
          productMap.get(`gid://shopify/Product/${productId}`) ||
          {};

        productMap.set(gidKey, {
          ...current,
          key: gidKey,
          id: productId,
          gid: node.id,
          title: node.title || current.title || `Product ${productId}`,
          handle: node.handle || current.handle || "",
          adminUrl: getProductAdminUrl(shopifyStoreHandle, productId),
        });

        if (numericKey && productMap.has(numericKey)) {
          productMap.delete(numericKey);
        }
        const generatedGid = `gid://shopify/Product/${productId}`;
        if (generatedGid !== gidKey && productMap.has(generatedGid)) {
          productMap.delete(generatedGid);
        }
      });
    } catch (error) {
      console.error("Failed to load selected product details:", error);
    }
  }

  return Array.from(productMap.values()).filter(
    (product) => product.id || product.gid || product.title,
  );
}

async function scheduledTaskGraphql(admin, query, variables = {}) {
  if (!admin?.graphql) return null;

  const response = await admin.graphql(query, { variables });
  const payload = await response.json();

  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  return payload?.data || null;
}

function normalizeScheduledPreviewProduct(product, shopifyStoreHandle, index = 0) {
  const source = product?.product || product || {};
  const productId = getShopifyNumericId(source.legacyResourceId || source.id || product?.productId);
  const title =
    source.title ||
    product?.productTitle ||
    product?.title ||
    (productId ? `Product ${productId}` : "Product");

  return {
    rowId: `scheduled-product-${productId || index}`,
    id: productId,
    gid: source.id?.includes?.("gid://shopify/Product/")
      ? source.id
      : product?.gid || (productId ? `gid://shopify/Product/${productId}` : ""),
    title,
    handle: source.handle || product?.handle || "",
    adminUrl: getProductAdminUrl(shopifyStoreHandle, productId),
  };
}

function uniqueScheduledPreviewProducts(products, shopifyStoreHandle) {
  const unique = new Map();

  products.forEach((product, index) => {
    const normalized = normalizeScheduledPreviewProduct(
      product,
      shopifyStoreHandle,
      index,
    );
    const key = normalized.gid || normalized.id || normalized.title || `product-${index}`;

    if (!unique.has(key)) {
      unique.set(key, normalized);
    }
  });

  return Array.from(unique.values());
}

async function loadScheduledProducts(admin, shopifyStoreHandle) {
  const products = [];
  let after = null;

  do {
    const data = await scheduledTaskGraphql(admin, SCHEDULED_PRODUCTS_QUERY, {
      first: Math.min(50, SCHEDULED_LOG_PREVIEW_LIMIT - products.length),
      after,
    });
    const connection = data?.products;
    products.push(...(connection?.nodes || []));
    after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (after && products.length < SCHEDULED_LOG_PREVIEW_LIMIT);

  return uniqueScheduledPreviewProducts(products, shopifyStoreHandle);
}

async function loadScheduledProductsByIds(admin, productIds, shopifyStoreHandle) {
  const ids = [
    ...new Set(
      getArrayValue(productIds)
        .map((id) => {
          const numericId = getShopifyNumericId(id);
          return String(id || "").includes("gid://shopify/Product/")
            ? String(id)
            : numericId
              ? `gid://shopify/Product/${numericId}`
              : "";
        })
        .filter(Boolean),
    ),
  ];

  if (!ids.length) return [];

  const data = await scheduledTaskGraphql(admin, SCHEDULED_PRODUCT_NODES_QUERY, {
    ids,
  });

  return uniqueScheduledPreviewProducts(data?.nodes || [], shopifyStoreHandle);
}

async function loadScheduledProductsByVariantIds(admin, variantIds, shopifyStoreHandle) {
  const ids = [
    ...new Set(
      getArrayValue(variantIds)
        .map((id) => {
          const numericId = getShopifyNumericId(id);
          return String(id || "").includes("gid://shopify/ProductVariant/")
            ? String(id)
            : numericId
              ? `gid://shopify/ProductVariant/${numericId}`
              : "";
        })
        .filter(Boolean),
    ),
  ];

  if (!ids.length) return [];

  const data = await scheduledTaskGraphql(admin, SCHEDULED_PRODUCT_NODES_QUERY, {
    ids,
  });

  return uniqueScheduledPreviewProducts(
    (data?.nodes || []).map((node) => node?.product).filter(Boolean),
    shopifyStoreHandle,
  );
}

async function loadScheduledProductsByCollectionIds(admin, collectionIds, shopifyStoreHandle) {
  const products = [];
  const ids = [
    ...new Set(
      getArrayValue(collectionIds)
        .map((id) => {
          const numericId = getShopifyNumericId(id);
          return String(id || "").includes("gid://shopify/Collection/")
            ? String(id)
            : numericId
              ? `gid://shopify/Collection/${numericId}`
              : "";
        })
        .filter(Boolean),
    ),
  ];

  for (const id of ids) {
    let after = null;

    do {
      const data = await scheduledTaskGraphql(
        admin,
        SCHEDULED_COLLECTION_PRODUCTS_QUERY,
        {
          id,
          first: Math.min(50, SCHEDULED_LOG_PREVIEW_LIMIT - products.length),
          after,
        },
      );
      const connection = data?.collection?.products;
      products.push(...(connection?.nodes || []));
      after = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after && products.length < SCHEDULED_LOG_PREVIEW_LIMIT);

    if (products.length >= SCHEDULED_LOG_PREVIEW_LIMIT) break;
  }

  return uniqueScheduledPreviewProducts(products, shopifyStoreHandle);
}

async function getScheduledPreviewProducts(
  admin,
  task,
  selectedApplyProducts,
  shopifyStoreHandle,
) {
  if (!isPendingScheduledTask(task)) return [];

  const applyScope = String(task.applyScope || "").toLowerCase();
  const applyResources = task.applyResources || {};

  try {
    if (applyScope === "selected_products") {
      if (selectedApplyProducts?.length) {
        return uniqueScheduledPreviewProducts(
          selectedApplyProducts,
          shopifyStoreHandle,
        );
      }

      return loadScheduledProductsByIds(
        admin,
        applyResources.productIds,
        shopifyStoreHandle,
      );
    }

    if (applyScope === "selected_products_with_variants") {
      return loadScheduledProductsByVariantIds(
        admin,
        applyResources.variantIds,
        shopifyStoreHandle,
      );
    }

    if (applyScope === "selected_collections") {
      return loadScheduledProductsByCollectionIds(
        admin,
        applyResources.collectionIds,
        shopifyStoreHandle,
      );
    }

    if (applyScope === "selected_tags") {
      return [];
    }

    return loadScheduledProducts(admin, shopifyStoreHandle);
  } catch (error) {
    console.error("Failed to load scheduled task preview products:", error);
    return uniqueScheduledPreviewProducts(
      selectedApplyProducts || [],
      shopifyStoreHandle,
    );
  }
}

function AdminLink({ url, children }) {
  if (!url) return children;

  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function buildVariantChanges(record, currencyCode) {
  return buildVariantChangeItems(record, currencyCode).map((change) => change.text);
}

function formatPriceValue(value) {
  return value === undefined || value === null || value === "" ? "-" : value;
}

function getCurrencySymbol(currencyCode) {
  const symbols = {
    INR: "₹",
    USD: "$",
    EUR: "€",
    GBP: "£",
    CAD: "$",
    AUD: "$",
  };

  return symbols[String(currencyCode || "").toUpperCase()] || "";
}

function formatMoneyValue(value, currencyCode) {
  const formattedValue = formatPriceValue(value);
  const currencySymbol = getCurrencySymbol(currencyCode);

  if (formattedValue === "-" || !currencySymbol) return formattedValue;

  return `${formattedValue} ${currencySymbol}`;
}

function buildVariantChangeItems(record, currencyCode) {
  const changes = [];

  if (record?.price !== record?.nextPrice) {
    changes.push({
      label: "Price",
      text: `Price: ${formatMoneyValue(record?.price, currencyCode)} → ${formatMoneyValue(
        record?.nextPrice,
        currencyCode,
      )}`,
    });
  }

  if (record?.compareAtPrice !== record?.nextCompareAtPrice) {
    changes.push({
      label: "Compare price",
      text: `Compare price: ${formatMoneyValue(
        record?.compareAtPrice,
        currencyCode,
      )} → ${formatMoneyValue(record?.nextCompareAtPrice, currencyCode)}`,
    });
  }

  if (record?.cost !== record?.nextCost) {
    changes.push({
      label: "Cost",
      text: `Cost: ${formatMoneyValue(record?.cost, currencyCode)} → ${formatMoneyValue(
        record?.nextCost,
        currencyCode,
      )}`,
    });
  }

  return changes;
}

function shouldShowPriceNoChange(task) {
  return ["set_to_compare_at_price", "set_margin"].includes(
    task.priceChange?.action,
  );
}

function summarizeProductChanges(changeItems, noChangeLabel = "") {
  if (!changeItems.length) {
    const fallback = noChangeLabel || "No changes recorded";

    return {
      items: [fallback],
      primary: fallback,
      moreCount: 0,
    };
  }

  const items = changeItems.map((change) => change.text);

  return {
    items,
    primary: items[0],
    moreCount: Math.max(items.length - 1, 0),
  };
}

function summarizeVariantValue(variants, field) {
  const values = [
    ...new Set(
      variants
        .map((variant) => formatPriceValue(variant[field]))
        .filter((value) => value !== "-"),
    ),
  ];

  if (!values.length) return "-";
  if (values.length === 1) return values[0];

  return "Multiple";
}

function isDefaultVariantTitle(title) {
  const normalized = String(title || "").trim().toLowerCase();
  return normalized === "default title" || normalized === "default";
}

function getDefaultVariant(variants) {
  if (!variants.length) return null;
  if (variants.length === 1) return variants[0];

  return variants.find((variant) => isDefaultVariantTitle(variant.title)) || variants[0];
}

function mergeVariantRecord(recordsByVariantId, record) {
  const variantId = getVariantId(record);
  if (!variantId) return;

  recordsByVariantId.set(variantId, {
    ...recordsByVariantId.get(variantId),
    ...record,
  });
}

function createProductGroups(task, shopifyStoreHandle, shopCurrency) {
  const groups = new Map();
  const originalVariants = task.executionSummary?.originalVariants || [];
  const originalInventoryItems =
    task.executionSummary?.originalInventoryItems || [];
  const originalMarketPrices = task.executionSummary?.originalMarketPrices || [];

  const recordsByVariantId = new Map();

  originalVariants.forEach((v) => mergeVariantRecord(recordsByVariantId, v));

  originalInventoryItems.forEach((i) => mergeVariantRecord(recordsByVariantId, i));

  originalMarketPrices.forEach((price) =>
    mergeVariantRecord(recordsByVariantId, {
      ...price,
      isMarketPrice: true,
      title: price.variantTitle,
    }),
  );

  function addRecord(record, index, type) {
    const productId = getProductId(record);
    const variantId = getVariantId(record);
    const productTitle = getProductTitle(record);
    const variantTitle = getVariantTitle(record);
    const sku = getVariantSku(record);

    const groupKey = productId
      ? `product-${productId}`
      : `${type}-${variantId || index}`;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        rowId: groupKey,
        productId,
        productTitle,
        adminUrl: getProductAdminUrl(shopifyStoreHandle, productId),
        variants: [],
        priceChangeCount: 0,
        compareAtChangeCount: 0,
        costChangeCount: 0,
        changeItems: [],
        status: getBaseTaskDisplay(task).label,
      });
    }

    const group = groups.get(groupKey);

    if (record?.price !== record?.nextPrice) group.priceChangeCount += 1;

    if (record?.compareAtPrice !== record?.nextCompareAtPrice) {
      group.compareAtChangeCount += 1;
    }

    if (record?.cost !== record?.nextCost) group.costChangeCount += 1;

    const currencyCode = record?.currencyCode || shopCurrency;
    const changeItems = buildVariantChangeItems(record, currencyCode);

    group.variants.push({
      rowId: `${groupKey}-${variantId || index}`,
      variantId,
      title: variantTitle,
      sku,
      price: record?.price,
      compareAtPrice: record?.compareAtPrice,
      newSetPrice: record?.nextPrice,
      cost: record?.cost,
      newSetCost: record?.nextCost,
      changes: changeItems.map((change) => change.text),
      changeItems,
      adminUrl: getVariantAdminUrl(shopifyStoreHandle, productId, variantId),
      type,
    });
  }

  Array.from(recordsByVariantId.values()).forEach((record, index) => {
    addRecord(record, index, "variant");
  });

  return Array.from(groups.values()).map((group) => {
    const changes = [
      group.priceChangeCount
        ? `${group.priceChangeCount} variant price change${group.priceChangeCount > 1 ? "s" : ""
        }`
        : "",
      group.compareAtChangeCount
        ? `${group.compareAtChangeCount} compare-at price change${group.compareAtChangeCount > 1 ? "s" : ""
        }`
        : "",
      group.costChangeCount
        ? `${group.costChangeCount} cost change${group.costChangeCount > 1 ? "s" : ""
        }`
        : "",
    ].filter(Boolean);

    const defaultVariant = getDefaultVariant(group.variants);
    const defaultVariantChangeItems = defaultVariant?.changeItems || [];

    return {
      ...group,
      changes: changes.length
        ? changes
        : [shouldShowPriceNoChange(task) ? "Price: no change" : "No changes recorded"],
      otherChanges: group.variants.flatMap((variant) => variant.changes),
      changeSummary: summarizeProductChanges(
        defaultVariantChangeItems,
        shouldShowPriceNoChange(task) ? "Price: no change" : "",
      ),
      price: summarizeVariantValue(group.variants, "price"),
      compareAtPrice: summarizeVariantValue(group.variants, "compareAtPrice"),
      newSetPrice: summarizeVariantValue(group.variants, "newSetPrice"),
      cost: summarizeVariantValue(group.variants, "cost"),
      newSetCost: summarizeVariantValue(group.variants, "newSetCost"),
      variantCount: group.variants.length,
    };
  });
}

function parseLogList(value) {
  if (!value) return [];

  if (Array.isArray(value)) return value;

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    } catch {
      return value.trim() ? [{ message: value }] : [];
    }
  }

  return typeof value === "object" ? [value] : [];
}

function getTaskLogRecords(task) {
  return [
    task.logs,
    task.log,
    task.taskLogs,
    task.executionLogs,
    task.rollbackLogs,
    task.rollbackLog,
    task.rollback?.logs,
    task.rollback?.log,
    task.rollbackSummary?.logs,
    task.rollbackSummary?.log,
    task.executionSummary?.logs,
    task.executionSummary?.log,
    task.executionSummary?.taskLogs,
    task.executionSummary?.executionLogs,
    task.executionSummary?.rollbackLogs,
    task.executionSummary?.rollbackLog,
    task.executionSummary?.rollback?.logs,
    task.executionSummary?.rollback?.log,
    task.executionSummary?.rollbackSummary?.logs,
    task.executionSummary?.rollbackSummary?.log,
  ].flatMap(parseLogList);
}

function getLogMessage(record) {
  const changes = Array.isArray(record?.changes)
    ? record.changes.filter(Boolean).join(", ")
    : record?.changes;

  return (
    record?.message ||
    record?.log ||
    record?.description ||
    record?.summary ||
    record?.action ||
    changes ||
    "Log recorded"
  );
}

function createFallbackLogGroups(task, shopifyStoreHandle) {
  return getTaskLogRecords(task).map((record, index) => {
    const productId = getProductId(record);

    return {
      rowId: `raw-log-${record?.id || productId || index}`,
      productId,
      productTitle: getProductTitle(record),
      adminUrl: getProductAdminUrl(shopifyStoreHandle, productId),
      changes: [getLogMessage(record)],
      otherChanges: [],
      changeSummary: {
        items: [getLogMessage(record)],
        primary: getLogMessage(record),
        moreCount: 0,
      },
      price: formatPriceValue(record?.price),
      compareAtPrice: formatPriceValue(record?.compareAtPrice),
      newSetPrice: formatPriceValue(record?.nextPrice || record?.newSetPrice),
      variantCount: Number(record?.variantCount || 0),
      variants: [],
      status: getCanceledStatusLabel(record?.status || getTaskStatusValue(task)),
    };
  });
}

function createScheduledPreviewLogGroups(
  task,
  scheduledPreviewProducts,
  shopifyStoreHandle,
  shopCurrency,
) {
  if (!isPendingScheduledTask(task) || !scheduledPreviewProducts?.length) {
    return [];
  }

  const changes = getTaskChangeItems(task, shopCurrency);
  const fallbackChange = changes.length ? changes[0] : "Scheduled price change";

  return scheduledPreviewProducts.map((product, index) => {
    const productId = getShopifyNumericId(product.id || product.gid);
    const title = product.title || (productId ? `Product ${productId}` : "Product");
    const changeItems = changes.length ? changes : [fallbackChange];

    return {
      rowId: `scheduled-preview-${productId || index}`,
      productId,
      productTitle: title,
      adminUrl:
        product.adminUrl || getProductAdminUrl(shopifyStoreHandle, productId),
      changes: changeItems,
      otherChanges: [],
      changeSummary: {
        items: changeItems,
        primary: changeItems[0],
        moreCount: Math.max(changeItems.length - 1, 0),
      },
      price: "-",
      compareAtPrice: "-",
      newSetPrice: "-",
      cost: "-",
      newSetCost: "-",
      variantCount: 0,
      variants: [],
      status: "Schedule",
    };
  });
}

function filterLogs(logs, searchQuery) {
  const query = searchQuery.trim().toLowerCase();

  if (!query) return logs;

  return logs.filter((log) => {
    const searchableText = [
      log.productTitle,
      log.productId,
      log.variantCount,
      log.status,
      ...(log.changes || []),
      log.price,
      log.compareAtPrice,
      log.newSetPrice,
      log.cost,
      log.newSetCost,
      log.changeSummary?.primary,
      ...(log.variants || []).flatMap((variant) => [
        variant.title,
        variant.sku,
        variant.variantId,
        variant.price,
        variant.compareAtPrice,
        variant.newSetPrice,
        variant.cost,
        variant.newSetCost,
        ...(variant.changes || []),
      ]),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();

    return searchableText.includes(query);
  });
}

function getAppliedAt(task) {
  return (
    task.executionSummary?.completedAt ||
    task.executionSummary?.appliedAt ||
    task.completedAt ||
    task.appliedAt ||
    task.updatedAt ||
    task.createdAt
  );
}

function getProductDetails(task, productId, shopifyStoreHandle, shopCurrency = "") {
  const originalVariants = task.executionSummary?.originalVariants || [];
  const originalInventoryItems =
    task.executionSummary?.originalInventoryItems || [];
  const originalMarketPrices = task.executionSummary?.originalMarketPrices || [];

  const recordsByVariantId = new Map();

  originalVariants
    .filter((v) => getProductId(v) === productId)
    .forEach((v) => mergeVariantRecord(recordsByVariantId, v));

  originalInventoryItems
    .filter((i) => getProductId(i) === productId)
    .forEach((i) => mergeVariantRecord(recordsByVariantId, i));

  originalMarketPrices
    .filter((price) => getProductId(price) === productId)
    .forEach((price) =>
      mergeVariantRecord(recordsByVariantId, {
        ...price,
        isMarketPrice: true,
        title: price.variantTitle,
      }),
    );

  const allRecords = Array.from(recordsByVariantId.values()).map((record, index) => {
    const variantId = getVariantId(record);
    const currencyCode = record.currencyCode || shopCurrency;
    return {
      rowId: `variant-${variantId || index}`,
      variantId,
      productTitle: getProductTitle(record),
      title: getVariantTitle(record),
      sku: getVariantSku(record),
      price: record.price,
      compareAtPrice: record.compareAtPrice,
      newSetPrice: record.nextPrice,
      cost: record.cost,
      newSetCost: record.nextCost,
      changes: buildVariantChanges(record, currencyCode),
      adminUrl: getVariantAdminUrl(shopifyStoreHandle, productId, variantId),
    };
  });

  if (!allRecords.length) return null;

  const firstOriginalRecord = allRecords[0];

  return {
    productId,
    productTitle: getProductTitle(firstOriginalRecord),
    adminUrl: getProductAdminUrl(shopifyStoreHandle, productId),
    variants: allRecords.map((record) => ({
      ...record,
      changes: record.changes.length
        ? record.changes
        : [shouldShowPriceNoChange(task) ? "Price: no change" : "No changes recorded"],
    })),
    appliedAt: getAppliedAt(task),
  };
}

function getScheduleStatusDisplay(task) {
  if (!isScheduledTask(task)) {
    return { label: "No", tone: "subdued" };
  }

  const status = normalizeScheduleStatus(task) || "pending";

  if (status === "running") return { label: "Running", tone: "success" };
  if (status === "completed") return { label: "Completed", tone: "subdued" };
  if (status === "cancelled" || status === "canceled") {
    return { label: "Cancelled", tone: "critical" };
  }

  return { label: "Pending", tone: "attention" };
}

function StatusBadge({ display }) {
  const showPendingSpinner = Boolean(display.showPendingSpinner);
  const showProgress = Boolean(display.showProgress);
  const progress = Math.max(
    0,
    Math.min(100, Math.round(Number(display.progress) || 0)),
  );

  return (
    <span
      style={{
        alignItems: "center",
        background: display.background,
        borderRadius: 8,
        display: "inline-flex",
        fontWeight: 600,
        gap: 4,
        lineHeight: 1,
        padding: "6px 10px",
      }}
    >
      {showPendingSpinner ? (
        <span style={{ display: "inline-flex", transform: "scale(0.75)", transformOrigin: "center" }}>
          <Spinner accessibilityLabel="Task status loading" size="small" />
        </span>
      ) : display.tone === "attention" ? (
        <span
          aria-hidden="true"
          style={{
            background: "#B98900",
            borderRadius: "50%",
            display: "inline-block",
            height: 8,
            width: 8,
          }}
        />
      ) : null}
      {display.label}
      {showProgress ? <span>{progress}%</span> : null}
    </span>
  );
}

function DetailRow({ label, value, children }) {
  return (
    <Box paddingBlock="300" borderBlockEndWidth="025" borderColor="border">
      <InlineStack gap="800" blockAlign="center" wrap={false}>
        <Box minWidth="220px">
          <Text as="p" fontWeight="semibold">
            {label}
          </Text>
        </Box>

        {children || (
          <Text as="p" fontWeight="regular">
            {value}
          </Text>
        )}
      </InlineStack>
    </Box>
  );
}

// eslint-disable-next-line no-unused-vars
function ApplyToDetails({ task, selectedCollections }) {
  const applyScopeLabel = humanize(task.applyScope);

  if (!selectedCollections?.length) {
    return (
      <Text as="p" fontWeight="regular">
        {applyScopeLabel}
      </Text>
    );
  }

  return (
    <BlockStack gap="200">
      <Text as="p" fontWeight="semibold">
        {applyScopeLabel}
      </Text>

      <BlockStack gap="150">
        {selectedCollections.map((collection, index) => (
          <InlineStack
            key={collection.key || collection.id || index}
            gap="300"
            blockAlign="center"
            wrap={false}
          >
            <span
              aria-hidden="true"
              style={{
                alignItems: "center",
                border: "1px solid #D9D9D9",
                borderRadius: 8,
                color: "#6D7175",
                display: "inline-flex",
                flex: "0 0 48px",
                height: 48,
                justifyContent: "center",
                width: 48,
              }}
            >
              ◇
            </span>

            <Text as="p" fontWeight="regular">
              <AdminLink url={collection.adminUrl}>
                {collection.title || collection.handle || "Collection"}
              </AdminLink>
            </Text>
          </InlineStack>
        ))}
      </BlockStack>
    </BlockStack>
  );
}

function getConfiguredRecords(configuration, prefix, type) {
  if (type === "collection") {
    return buildCollectionRecordsFromIds(
      getConfigArray(configuration, `${prefix}_collection_ids[]`),
      getConfigArray(configuration, `${prefix}_collection_titles[]`),
      getConfigArray(configuration, `${prefix}_collection_handles[]`),
      getConfigArray(configuration, `${prefix}_collection_products_counts[]`),
      getConfigArray(configuration, `${prefix}_collection_image_urls[]`),
    );
  }

  if (type === "product") {
    const ids = getConfigArray(configuration, `${prefix}_product_ids[]`);
    const titles = getConfigArray(configuration, `${prefix}_product_titles[]`);

    return ids.map((id, index) => ({ id, title: titles[index] || "" }));
  }

  if (type === "variant") {
    const ids = getConfigArray(configuration, `${prefix}_variant_ids[]`);
    const titles = getConfigArray(configuration, `${prefix}_variant_titles[]`);
    const productIds = getConfigArray(configuration, `${prefix}_variant_product_ids[]`);
    const productTitles = getConfigArray(configuration, `${prefix}_variant_product_titles[]`);

    return ids.map((id, index) => ({
      id,
      title: titles[index] || "",
      productId: productIds[index] || "",
      productTitle: productTitles[index] || "",
    }));
  }

  if (type === "tag") {
    return getConfigArray(configuration, `${prefix}_tag_names[]`).map((title) => ({
      id: title,
      title,
    }));
  }

  return [];
}

function uniqueResourceRecords(records) {
  const unique = new Map();

  records.forEach((record, index) => {
    const key =
      record?.gid ||
      record?.id ||
      record?.title ||
      record?.handle ||
      `resource-${index}`;

    if (!unique.has(key)) {
      unique.set(key, record);
    }
  });

  return Array.from(unique.values());
}

function getSelectedResourceRecords(task, prefix, type, selectedCollections = []) {
  const resources =
    prefix === "apply" ? task.applyResources || {} : task.excludeResources || {};
  const configuration = task.configuration || {};

  if (type === "collection") {
    if (selectedCollections?.length) {
      return selectedCollections;
    }

    return uniqueResourceRecords(
      [
        ...getArrayValue(resources.collections),
        ...buildCollectionRecordsFromIds(resources.collectionIds),
        ...getArrayValue(resources.selectedCollections),
        ...getConfiguredRecords(configuration, prefix, type),
      ].map((record, index) => normalizeCollectionRecord(record, index)),
    );
  }

  if (type === "product") {
    return uniqueResourceRecords([
      ...getArrayValue(resources.products),
      ...getArrayValue(resources.selectedProducts),
      ...getConfiguredRecords(configuration, prefix, type),
      ...getArrayValue(resources.productIds).map((id) => ({ id })),
    ]);
  }

  if (type === "variant") {
    return uniqueResourceRecords([
      ...getArrayValue(resources.variants),
      ...getArrayValue(resources.selectedVariants),
      ...getConfiguredRecords(configuration, prefix, type),
      ...getArrayValue(resources.variantIds).map((id) => ({ id })),
    ]);
  }

  if (type === "tag") {
    return uniqueResourceRecords([
      ...getArrayValue(resources.tags),
      ...getArrayValue(resources.selectedTags),
      ...getArrayValue(resources.tagNames).map((title) => ({ id: title, title })),
      ...getConfiguredRecords(configuration, prefix, type),
    ]);
  }

  return [];
}

function ResourceList({ records, type, shopifyStoreHandle }) {
  if (!records.length) return null;

  return (
    <BlockStack gap="150">
      {records.map((item, index) => {
        const productId =
          type === "variant"
            ? getProductId(item)
            : getShopifyNumericId(item.productId || item.id || item.gid);
        const variantId =
          type === "variant" ? getVariantId(item) : "";
        const label =
          type === "variant"
            ? `${getProductTitle(item) ? `${getProductTitle(item)} - ` : ""}${getVariantTitle(item) || item.id || "Variant"
            }`
            : item.title || item.handle || item.id || humanize(type);
        const url =
          type === "collection"
            ? item.adminUrl ||
            getCollectionAdminUrl(
              shopifyStoreHandle,
              getShopifyNumericId(item.id || item.gid),
            )
            : type === "product"
              ? getProductAdminUrl(shopifyStoreHandle, productId)
              : type === "variant"
                ? getVariantAdminUrl(shopifyStoreHandle, productId, variantId)
                : "";

        if (type === "product") {
          return (
            <BlockStack
              gap="050"
              key={`${type}-${item.id || item.gid || item.title || index}`}
            >
              <Text as="p" fontWeight="regular">
                <AdminLink url={url}>
                  {item.title || item.handle || `Product ${productId || ""}`.trim()}
                </AdminLink>
              </Text>
       
              {url ? (
                <Text as="p" fontWeight="regular">
                  <AdminLink url={url}>Open in Shopify Admin</AdminLink>
                </Text>
              ) : null}
            </BlockStack>
          );
        }

        return (
          <Text as="p" fontWeight="regular" key={`${type}-${item.id || item.title || index}`}>
            <AdminLink url={url}>{label}</AdminLink>
          </Text>
        );
      })}
    </BlockStack>
  );
}

function SelectionDetails({
  task,
  prefix,
  scope,
  selectedCollections,
  selectedProducts,
  shopifyStoreHandle,
}) {
  const collections = getSelectedResourceRecords(
    task,
    prefix,
    "collection",
    selectedCollections,
  );
  const products = selectedProducts?.length
    ? selectedProducts
    : getSelectedResourceRecords(task, prefix, "product");
  const variants = getSelectedResourceRecords(task, prefix, "variant");
  const tags = getSelectedResourceRecords(task, prefix, "tag");
  const hasSelections =
    collections.length || products.length || variants.length || tags.length;

  return (
    <BlockStack gap="200">
      <Text as="p" fontWeight="semibold">
        {humanize(scope)}
      </Text>

      {hasSelections ? (
        <BlockStack gap="200">
          <ResourceList
            records={collections}
            type="collection"
            shopifyStoreHandle={shopifyStoreHandle}
          />
          <ResourceList
            records={products}
            type="product"
            shopifyStoreHandle={shopifyStoreHandle}
          />
          <ResourceList
            records={variants}
            type="variant"
            shopifyStoreHandle={shopifyStoreHandle}
          />
          <ResourceList
            records={tags}
            type="tag"
            shopifyStoreHandle={shopifyStoreHandle}
          />
        </BlockStack>
      ) : null}
    </BlockStack>
  );
}

function ProductDetailsView({ task, productDetails, backUrl }) {
  const rollbackState = getRollbackState(task);
  const statusDisplay = getDetailsStatusDisplay(task, rollbackState);
  const statusTone = getStatusToneFromDisplay(statusDisplay);
  const rowStatusLabel = getLogStatusLabel(task, statusDisplay, rollbackState);

  return (
    <Page
      title="Price change details"
      titleMetadata={<Badge tone={statusTone}>{statusDisplay.label}</Badge>}
      backAction={{
        content: "Task details",
        url: backUrl,
      }}
    >
      <TitleBar title="Boltr Bulk Price Editor" />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <DetailRow label="Product">
                <Text as="p" fontWeight="regular">
                  <AdminLink url={productDetails?.adminUrl}>
                    {productDetails?.productTitle || "-"}
                  </AdminLink>
                </Text>
              </DetailRow>

              <DetailRow label="Status">
                <StatusBadge display={statusDisplay} />
              </DetailRow>

              <DetailRow
                label="Applied"
                value={formatDate(productDetails?.appliedAt)}
              />
            </Card>

            <Card padding="0">
              <Box padding="400">
                <Text as="h2" variant="headingMd">
                  Variants
                </Text>
              </Box>

              <IndexTable
                resourceName={{ singular: "variant", plural: "variants" }}
                itemCount={productDetails?.variants?.length || 0}
                selectable={false}
                headings={[
                  { title: "Title" },
                  { title: "SKU" },
                  { title: "Changes" },
                  { title: "Status" },
                ]}
              >
                {(productDetails?.variants || []).map((variant, index) => (
                  <IndexTable.Row
                    id={variant.rowId}
                    key={variant.rowId}
                    position={index}
                  >
                    <IndexTable.Cell>
                      <Text as="span" fontWeight="regular">
                        <AdminLink url={variant.adminUrl}>
                          {variant.title}
                        </AdminLink>
                      </Text>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <Text as="span">{variant.sku || "-"}</Text>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <Text as="span">
                        {variant.changes.length
                          ? variant.changes.join(", ")
                          : "-"}
                      </Text>
                    </IndexTable.Cell>

                    <IndexTable.Cell>
                      <Badge tone={statusTone}>{rowStatusLabel}</Badge>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>

              {!productDetails?.variants?.length ? (
                <Box padding="400">
                  <Text as="p" tone="subdued">
                    No variant details found for this product.
                  </Text>
                </Box>
              ) : null}
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

export default function TaskDetailsPage() {
  const {
    task,
    shopifyStoreHandle,
    selectedProductId,
    productDetails,
    selectedApplyCollections,
    selectedExcludeCollections,
    selectedApplyProducts,
    selectedExcludeProducts,
    scheduledPreviewProducts,
    shopCurrency,
    toastMessage,
  } = useLoaderData();
  const selectedCollections = selectedApplyCollections || [];
  const taskMarkets = getTaskMarkets(task);
  const isMarketTask = String(task.applyChangesTo || "").toLowerCase() === "markets";

  const shopify = useAppBridge();
  const navigate = useNavigate();
  const location = useLocation();
  const revalidator = useRevalidator();
  const deleteFetcher = useFetcher();
  const autoReapplyFetcher = useFetcher();
  const submit = useSubmit();

  const rollbackState = getRollbackState(task);
  const taskCompleted = isTaskCompleted(task);
  const taskProcessing = isTaskProcessing(task);
  const taskPending = isTaskPending(task);
  const pendingScheduledTask = isPendingScheduledTask(task); // Added
  const scheduleStatusDisplay = getScheduleStatusDisplay(task);
  const runningScheduledTask = isRunningScheduledTask(task); // Added
  const autoReapplyEnabled = isAutoReapplyEnabled(task);
  const isAutoReapplySubmitting = autoReapplyFetcher.state !== "idle";

  const [rollbackModalOpen, setRollbackModalOpen] = useState(false);
  const [clientRollbackStarted, setClientRollbackStarted] = useState(false);
  const [progressNowMs, setProgressNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (toastMessage) {
      shopify.toast.show(toastMessage);
    }
  }, [shopify, toastMessage]);

  const rollbackCompleted = rollbackState.isCompleted;
  const rollbackFailed = rollbackState.isFailed;

  const rollbackProcessing =
    !rollbackCompleted &&
    !rollbackFailed &&
    (rollbackState.isProcessing || clientRollbackStarted);

  const baseStatusDisplay = getBaseTaskDisplay(task);

  const statusDisplay = rollbackProcessing
    ? {
      label: "Cancelling",
      tone: "attention",
      background: "#FEDF89",
      progress: rollbackState.progress,
      showPendingSpinner: true,
      showProgress: true,
    }
    : rollbackCompleted
      ? {
        label: "Cancelled",
        tone: "success",
        background: "#D1FADF",
        showProgress: false,
      }
      : rollbackFailed
        ? {
          label: getCanceledStatusLabel(getRollbackStatusValue(task) || getTaskStatusValue(task) || "Cancel"),
          tone: "critical",
          background: "#FEE4E2",
          showProgress: false,
        }
        : baseStatusDisplay;

  const visibleStatusDisplay =
    taskProcessing && statusDisplay.showProgress
      ? {
        ...statusDisplay,
        progress: getLiveApplyingProgress(
          task,
          statusDisplay.progress,
          progressNowMs,
        ),
      }
      : rollbackProcessing && statusDisplay.showProgress
        ? {
          ...statusDisplay,
          progress: getLiveCancellingProgress(
            task,
            statusDisplay.progress,
            progressNowMs,
          ),
        }
      : statusDisplay;

  const statusTone = getStatusToneFromDisplay(visibleStatusDisplay);
  const logStatusLabel = isScheduledTask(task)
    ? "Schedule"
    : getLogStatusLabel(task, visibleStatusDisplay, rollbackState);

  const logs = useMemo(() => {
    const productLogs = createProductGroups(task, shopifyStoreHandle, shopCurrency);
    const scheduledLogs = createScheduledPreviewLogGroups(
      task,
      scheduledPreviewProducts,
      shopifyStoreHandle,
      shopCurrency,
    );
    const fallbackLogs = createFallbackLogGroups(task, shopifyStoreHandle);

    if (productLogs.length) return productLogs;
    if (scheduledLogs.length) return scheduledLogs;

    return fallbackLogs;
  }, [task, scheduledPreviewProducts, shopifyStoreHandle, shopCurrency]);

  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);

  const filteredLogs = useMemo(
    () => filterLogs(logs, searchQuery),
    [logs, searchQuery],
  );

  const totalPages = Math.max(
    1,
    Math.ceil(filteredLogs.length / LOGS_PER_PAGE),
  );
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStart = (safeCurrentPage - 1) * LOGS_PER_PAGE;
  const paginatedLogs = filteredLogs.slice(
    pageStart,
    pageStart + LOGS_PER_PAGE,
  );

  const shouldPoll =
    !selectedProductId && (taskPending || taskProcessing || rollbackProcessing);

  const openRollbackModal = () => {
    setRollbackModalOpen(true);
  };

  const closeRollbackModal = () => {
    if (rollbackProcessing) return;
    setRollbackModalOpen(false);
  };

  const confirmRollback = () => {
    setRollbackModalOpen(false);
    setClientRollbackStarted(true);
    const formData = new FormData();
    formData.set("redirectTo", `/app/tasks/${task.id}`);
    submit(formData, {
      method: "post",
      action: `/app/tasks/${task.id}/rollback`,
    });
  };

  const handleDelete = () => {
    deleteFetcher.submit(
      { intent: "delete" },
      {
        method: "post",
        action: `/app/tasks/${task.id}`,
      },
    );
  };

  const handleDisableAutoReapply = () => {
    if (!autoReapplyEnabled || isAutoReapplySubmitting) return;

    autoReapplyFetcher.submit(
      { intent: "disable_auto_reapply" },
      {
        method: "post",
        action: `/app/tasks/${task.id}`,
      },
    );
  };

  const handleCancelSchedule = () => {
    if (isAutoReapplySubmitting) return;
    autoReapplyFetcher.submit(
      { intent: "cancel_schedule" },
      {
        method: "post",
        action: `/app/tasks/${task.id}`,
      },
    );
  };

  const pageSecondaryActions = [];

  if (!rollbackProcessing && !rollbackFailed) {
    if (rollbackCompleted) {
      pageSecondaryActions.push({
        content: deleteFetcher.state === "idle" ? "Delete" : "Deleting...",
        destructive: true,
        disabled: deleteFetcher.state !== "idle",
        onAction: handleDelete,
      });
    } else {
      pageSecondaryActions.push({
        content: "Rollback",
        disabled: !taskCompleted,
        onAction: openRollbackModal,
      });

      if (taskCompleted && autoReapplyEnabled) {
        pageSecondaryActions.push({
          content: isAutoReapplySubmitting
            ? "Disabling auto-reapply..."
            : "Disable auto-reapply",
          disabled: isAutoReapplySubmitting,
          onAction: handleDisableAutoReapply,
        });
      }
    }
  }

  // New: Actions for pending scheduled tasks
  if (pendingScheduledTask) {
    pageSecondaryActions.push({
      content: "Edit task",
      url: withShopifyEmbeddedParams(`/app/tasks/new?id=${task.id}`, location.search),
    });
    pageSecondaryActions.push({
      content: isAutoReapplySubmitting ? "Cancelling schedule..." : "Cancel schedule",
      destructive: true,
      disabled: isAutoReapplySubmitting,
      onAction: handleCancelSchedule,
    });
  }



  useEffect(() => {
    if (deleteFetcher.data?.deleted) {
      if (deleteFetcher.data.message) {
        shopify.toast.show(deleteFetcher.data.message);
      }
      navigate("/app/tasks");
    }
  }, [deleteFetcher.data, navigate, shopify]);

  useEffect(() => {
    if (autoReapplyFetcher.data?.disabledAutoReapply) {
      revalidator.revalidate();
    }
  }, [autoReapplyFetcher.data, revalidator]);

  useEffect(() => {
    if (rollbackCompleted || rollbackFailed) {
      setClientRollbackStarted(false);
      setRollbackModalOpen(false);
    }
  }, [rollbackCompleted, rollbackFailed]);

  useEffect(() => {
    if (!taskProcessing && !rollbackProcessing && !runningScheduledTask) return;

    const timer = setInterval(() => {
      setProgressNowMs(Date.now());
    }, 1000);

    return () => clearInterval(timer);
  }, [taskProcessing, rollbackProcessing, runningScheduledTask]);
  
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages));
  }, [totalPages]);

  useEffect(() => {
    if (!shouldPoll) return undefined;

    const timer = setInterval(() => {
      revalidator.revalidate();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [revalidator, shouldPoll]);

  if (selectedProductId) {
    return (
      <ProductDetailsView
        task={task}
        productDetails={productDetails}
        backUrl={withShopifyEmbeddedParams(`/app/tasks/${task.id}`, location.search)}
      />
    );
  }

  return (
    <Page
      title="Task details"
      backAction={{
        content: "Tasks",
        url: withShopifyEmbeddedParams("/app/tasks", location.search),
      }}
      secondaryActions={pageSecondaryActions}
    >
      <TitleBar title="Boltr Bulk Price Editor" />

      <Modal
        open={rollbackModalOpen}
        onClose={closeRollbackModal}
        title="Confirm rollback"
        primaryAction={{
          content: "Yes, rollback",
          destructive: true,
          onAction: confirmRollback,
          disabled: rollbackProcessing,
        }}
        secondaryActions={[
          {
            content: "Cancel",
            onAction: closeRollbackModal,
            disabled: rollbackProcessing,
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p">
              Are you sure you want to rollback this task? This will revert the
              product changes made by this task.
            </Text>

            <Text as="p" tone="subdued">
              Click Yes only when you want to restore the previous product
              values.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>

      <div style={{ maxWidth: 1400, margin: "0 auto" }}>
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              <Card>
                <DetailRow label="Changes">
                  <ChangeDetails task={task} shopCurrency={shopCurrency} />
                </DetailRow>

                <DetailRow
                  label="Change type"
                >
                  <BlockStack gap="050">
                    <Text as="p" fontWeight="semibold">
                      {humanize(task.applyChangesTo || "products")}
                    </Text>

                    {isMarketTask && taskMarkets.map((market) => (
                      <Text as="p" tone="subdued" key={market.id || market.name || market.label}>
                        - {formatMarketLabel(market)}
                      </Text>
                    ))}
                  </BlockStack>
                </DetailRow>

                <DetailRow label="Apply to">
                  <SelectionDetails
                    task={task}
                    prefix="apply"
                    scope={task.applyScope}
                    selectedCollections={selectedCollections}
                    selectedProducts={selectedApplyProducts || []}
                    shopifyStoreHandle={shopifyStoreHandle}
                  />
                </DetailRow>

                <DetailRow label="Exclude">
                  <SelectionDetails
                    task={task}
                    prefix="exclude"
                    scope={task.excludeScope}
                    selectedCollections={selectedExcludeCollections || []}
                    selectedProducts={selectedExcludeProducts || []}
                    shopifyStoreHandle={shopifyStoreHandle}
                  />
                </DetailRow>

                <DetailRow
                  label="Exclude discounted"
                  value={formatDiscountedScope(task)}
                />

                <DetailRow label="Status">
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <StatusBadge display={visibleStatusDisplay} />
                  </InlineStack>
                </DetailRow>

                {isMarketTask && taskMarkets.length ? (
                  <DetailRow label="Markets">
                    <InlineStack gap="100" blockAlign="center">
                      {taskMarkets.map((market) => (
                        <Badge key={market.id || market.name || market.label}>
                          {formatMarketLabel(market)}
                        </Badge>
                      ))}
                    </InlineStack>
                  </DetailRow>
                ) : null}

                <DetailRow label="Created at" value={formatDate(task.createdAt)} />
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Logs
                  </Text>

                  <TextField
                    label="Product name"
                    labelHidden
                    value={searchQuery}
                    onChange={setSearchQuery}
                    placeholder="Product name"
                    clearButton
                    onClearButtonClick={() => setSearchQuery("")}
                    autoComplete="off"
                  />

                  <IndexTable
                    resourceName={{ singular: "log", plural: "logs" }}
                    itemCount={paginatedLogs.length}
                    selectable={false}
                    headings={[
                      { title: "Product" },
                      { title: "Changes" },
                      { title: "Status" },
                      { title: "" },
                    ]}
                  >
                    {paginatedLogs.map((log, index) => (
                      <IndexTable.Row
                        id={log.rowId}
                        key={log.rowId}
                        position={index}
                      >
                        <IndexTable.Cell>
                          <Text as="span" fontWeight="regular">
                            <AdminLink url={log.adminUrl}>
                              {log.productTitle}
                            </AdminLink>
                          </Text>
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <BlockStack gap="100">
                            {(log.changeSummary?.items?.length
                              ? log.changeSummary.items
                              : [log.changeSummary?.primary || "-"]
                            ).map((change, changeIndex) => (
                              <Text
                                as="span"
                                key={`${log.rowId}-change-${changeIndex}`}
                              >
                                {change}
                              </Text>
                            ))}
                          </BlockStack>
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <Badge tone={statusTone}>{logStatusLabel}</Badge>
                        </IndexTable.Cell>

                        <IndexTable.Cell>
                          <Button
                            size="slim"
                            disabled={!log.productId}
                            url={
                              log.productId
                                ? `/app/tasks/${task.id}?productId=${log.productId}`
                                : undefined
                            }
                          >
                            Details
                          </Button>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    ))}
                  </IndexTable>

                  {!filteredLogs.length ? (
                    <Box padding="400">
                      <Text as="p" tone="subdued">
                        {searchQuery
                          ? "No logs found for your search."
                          : "No product changes were recorded for this task."}
                      </Text>
                    </Box>
                  ) : null}

                  {filteredLogs.length > LOGS_PER_PAGE ? (
                    <InlineStack align="center">
                      <Pagination
                        hasPrevious={safeCurrentPage > 1}
                        onPrevious={() =>
                          setCurrentPage((page) => Math.max(1, page - 1))
                        }
                        hasNext={safeCurrentPage < totalPages}
                        onNext={() =>
                          setCurrentPage((page) =>
                            Math.min(totalPages, page + 1),
                          )
                        }
                      />
                    </InlineStack>
                  ) : null}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </div>
    </Page>
  );
}
