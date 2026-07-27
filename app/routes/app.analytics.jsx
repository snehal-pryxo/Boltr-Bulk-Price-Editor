import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Card,
  Icon,
  IndexTable,
  InlineGrid,
  InlineStack,
  Link,
  Page,
  Pagination,
  Select,
  Tabs,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  ChartHistogramGrowthIcon,
  CollectionIcon,
  DiscountIcon,
  MarketsIcon,
  ProductIcon,
  ProductReturnIcon,
  StoreIcon,
} from "@shopify/polaris-icons";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { normalizeSaleStatus, SALE_STATUS } from "../lib/sale-status";
import PeriodComparisonChart from "../components/PeriodComparisonChart";

const RECORD_TYPE_OPTIONS = [
  { label: "All", value: "all" },
  { label: "Tasks", value: "tasks" },
  { label: "Sales", value: "sales" },
];
const ROLLBACK_LIMIT = 8;
const RECENT_CHANGES_PAGE_SIZE = 8;
const TASK_APPLY_TO_OPTIONS = [
  { key: "whole_store", label: "Whole store", type: "store" },
  { key: "selected_collections", label: "Selected collections", type: "collection" },
  { key: "selected_products", label: "Selected products", type: "product" },
  { key: "selected_products_with_variants", label: "Selected products with variants", type: "product" },
  { key: "all_store_products_not_on_sale", label: "All store products not on sale", type: "product" },
  { key: "selected_tags", label: "Selected tags", type: "tag" },
];
const SALE_APPLY_TO_OPTIONS = TASK_APPLY_TO_OPTIONS.filter(
  (option) => option.key !== "all_store_products_not_on_sale",
);

const metricIconStyle = {
  width: 52,
  height: 52,
  borderRadius: 12,
  display: "grid",
  placeItems: "center",
  flex: "0 0 52px",
};

const metricCardStyle = {
  minHeight: 112,
  height: 112,
  display: "flex",
  flexDirection: "column",
  position: "relative",
};

const metricCardInnerStyle = {
  height: "100%",
};

const metricCardContentStyle = {
  height: 90,
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  overflow: "hidden",
};

const metricSparklineStyle = {
  width: 120,
  height: 56,
  flex: "0 0 120px",
};

const metricSummaryStyle = {
  minHeight: 52,
  flex: "1 1 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
  textAlign: "left",
  minWidth: 0,
};

const pageContentStyle = {
  maxWidth: 1480,
  margin: "0 auto",
};

const ANALYTICS_CHART_DAYS = 30;
const scheduleSummaryColor = "#0ea5e9";

const rollbackTitleColumnStyle = {
  width: 220,
  minWidth: 220,
  maxWidth: 220,
  whiteSpace: "normal",
  overflowWrap: "anywhere",
};

const donutStyle = (stats) => ({
  width: 168,
  height: 168,
  borderRadius: "50%",
  background: buildDonutGradient(stats),
  display: "grid",
  placeItems: "center",
});

const donutInnerStyle = {
  width: 108,
  height: 108,
  borderRadius: "50%",
  background: "#fff",
  display: "grid",
  placeItems: "center",
  boxShadow: "inset 0 0 0 1px #eef0f2",
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const [tasks, sales] = await Promise.all([
    db.task.findMany({
      where: { shop: session.shop },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 250,
      include: {
        auditLogs: {
          orderBy: { createdAt: "desc" },
        },
      },
    }),
    db.sale.findMany({
      where: { shop: session.shop },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 250,
    }),
  ]);

  const allRecords = [
    ...tasks.map((task) => ({ kind: "task", record: task })),
    ...sales.map((sale) => ({ kind: "sale", record: sale })),
  ];
  const availableYears = getAvailableYears(allRecords);
  const stats = buildAnalysisStats(tasks, sales);
  const recentChanges = buildRecentChanges(tasks, sales, session.shop);
  const rollbackRows = buildRollbackRows(tasks, sales);
  const applyToSections = buildApplyToSections(tasks, sales);
  const chartRecords = buildChartRecords(tasks, sales);

  return json({
    availableYears,
    stats,
    recentChanges,
    rollbackRows,
    applyToSections,
    chartRecords,
  });
};

function getApplyToFilterOptions(selectedType = "all") {
  const sourceOptions = selectedType === "sales"
    ? SALE_APPLY_TO_OPTIONS
    : TASK_APPLY_TO_OPTIONS;

  return [
    { label: "All apply to", value: "all" },
    ...sourceOptions.map((option) => ({
      label: option.label,
      value: option.key,
    })),
  ];
}

function getApplyToFilterLabel(value, selectedType = "all") {
  return getApplyToFilterOptions(selectedType).find((option) => option.value === value)?.label || "All apply to";
}

function getApplyToBreakdownOptions(selectedType = "all", selectedApplyTo = "all") {
  if (selectedApplyTo !== "all") {
    return getApplyToFilterOptions(selectedType).filter((option) => option.value === selectedApplyTo);
  }

  return getApplyToFilterOptions(selectedType).filter((option) => option.value !== "all");
}

function getAvailableYears(records) {
  const years = records
    .map(({ record }) => getRecordDate(record))
    .filter(Boolean)
    .map((date) => new Date(date).getFullYear())
    .filter((year) => Number.isInteger(year));

  return [...new Set(years)].sort((a, b) => b - a).map(String);
}

function filterChartRecords(records, selectedType, selectedYear, selectedApplyTo) {
  return records.filter((record) => {
    if (selectedType === "tasks" && record.kind !== "task") return false;
    if (selectedType === "sales" && record.kind !== "sale") return false;

    if (selectedApplyTo !== "all" && normalizeApplyScope(record) !== selectedApplyTo) {
      return false;
    }

    if (selectedYear !== "all") {
      const date = getRecordDate(record);
      return date && String(new Date(date).getFullYear()) === selectedYear;
    }

    return true;
  });
}

function getRecordDate(record) {
  return record.date || record.completedAt || record.startedAt || record.startAt || record.updatedAt || record.createdAt;
}

function getSummary(record) {
  return record?.executionSummary &&
    typeof record.executionSummary === "object" &&
    !Array.isArray(record.executionSummary)
    ? record.executionSummary
    : {};
}

function getMarkets(record) {
  return record.selectedMarkets || record.markets || [];
}

function getMarketText(record) {
  const markets = getMarkets(record)
    .map((market) => {
      const name = market?.name || market?.label || market?.handle || "";
      const currency = market?.currencyCode || "";
      return [name, currency ? `(${currency})` : ""].filter(Boolean).join(" ");
    })
    .filter(Boolean);

  if (!markets.length) return "Products";
  return markets.join(", ");
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function getChangeCount(record) {
  const summary = getSummary(record);
  const logs = Array.isArray(summary.logs) ? summary.logs.length : undefined;

  return firstNumber(
    summary.totalPriceChanges,
    summary.updatedCount,
    summary.updatedVariants,
    summary.variantUpdates,
    summary.marketUpdates,
    logs,
  );
}

function getRecordChangeDate(record) {
  return isPendingScheduledRecord(record)
    ? record.startAt || record.date || record.updatedAt || record.createdAt
    : getRecordDate(record);
}

function getRecordAnalyticsStatus(record) {
  return isPendingScheduledRecord(record) ? "Schedule" : record.status;
}

function normalizeRecordStatus(record) {
  return String(record?.status || record?.scheduleStatus || "").toLowerCase();
}

function isPendingScheduledRecord(record) {
  const status = normalizeRecordStatus(record);
  const scheduleStatus = String(record?.scheduleStatus || "").toLowerCase();

  return Boolean(
    record?.scheduleEnabled ||
      record?.isScheduled ||
      status === "scheduled" ||
      status === "schedule" ||
      scheduleStatus === "pending" ||
      (record?.startAt && !record?.startedAt && !record?.completedAt),
  );
}

function getScheduledChangeCount(record) {
  if (!isPendingScheduledRecord(record)) return 0;

  const resources = getObjectValue(record.applyResources);
  const summary = getSummary(record);
  const summaryResources = getObjectValue(summary.applyResources);
  const configured = getObjectValue(record.configuration);
  const counts = [
    resources.productIds,
    resources.products,
    resources.variantIds,
    resources.variants,
    resources.collectionIds,
    resources.collections,
    resources.tagNames,
    summaryResources.productIds,
    summaryResources.products,
    summaryResources.variantIds,
    summaryResources.variants,
    summaryResources.collectionIds,
    summaryResources.collections,
    configured["apply_product_ids[]"],
    configured["apply_variant_ids[]"],
    configured["apply_collection_ids[]"],
  ]
    .map((value) => (Array.isArray(value) ? value.length : 0))
    .filter(Boolean);

  return Math.max(1, ...counts);
}

function getAnalyticsChangeCount(record) {
  return Math.max(getChangeCount(record), getScheduledChangeCount(record));
}

function hasRollback(record) {
  const summary = getSummary(record);
  const rollback = summary.rollback || {};
  const status = String(summary.rollbackStatus || rollback.status || record.status || "").toLowerCase();

  return (
    Boolean(summary.rollbackStartedAt || summary.rollbackCompletedAt) ||
    Boolean(rollback.completedAt || rollback.updatedVariants || rollback.totalPriceChanges) ||
    status.includes("rollback") ||
    status.includes("rolled back") ||
    status.includes("cancel")
  );
}

function buildAnalysisStats(tasks, sales) {
  const completedTasks = tasks.filter((task) => isCompletedTask(task)).length;
  const completedSales = sales.filter((sale) => normalizeSaleStatus(sale.status) === SALE_STATUS.COMPLETED).length;
  const scheduledRecords = [...tasks, ...sales].filter(isPendingScheduledRecord);
  const scheduledChanges = scheduledRecords.reduce((sum, record) => sum + getScheduledChangeCount(record), 0);
  const taskChanges = tasks.reduce((sum, task) => sum + getChangeCount(task), 0);
  const saleChanges = sales.reduce((sum, sale) => sum + getChangeCount(sale), 0);
  const rollbacks = [...tasks, ...sales].filter(hasRollback).length;
  const rollbackRecords = [...tasks, ...sales].filter(hasRollback);
  const allRecords = [...tasks, ...sales];
  const { currentStart, previousStart } = getPeriodBoundsForRecords();
  const changesRecords = allRecords;
  const tasksChart = buildDailySeriesForPeriod(tasks, getRecordChangeDate, () => 1, currentStart);
  const previousTasksChart = buildDailySeriesForPeriod(tasks, getRecordChangeDate, () => 1, previousStart);
  const salesChart = buildDailySeriesForPeriod(sales, getRecordChangeDate, () => 1, currentStart);
  const previousSalesChart = buildDailySeriesForPeriod(sales, getRecordChangeDate, () => 1, previousStart);
  const changesChart = buildDailySeriesForPeriod(
    changesRecords,
    getRecordChangeDate,
    (record) => getAnalyticsChangeCount(record) || 1,
    currentStart,
  );
  const previousChangesChart = buildDailySeriesForPeriod(
    changesRecords,
    getRecordChangeDate,
    (record) => getAnalyticsChangeCount(record) || 1,
    previousStart,
  );
  const rollbacksChart = buildDailySeriesForPeriod(rollbackRecords, (record) => getRecordDate(record), () => 1, currentStart);
  const previousRollbacksChart = buildDailySeriesForPeriod(rollbackRecords, (record) => getRecordDate(record), () => 1, previousStart);

  return {
    tasks: tasks.length,
    sales: sales.length,
    completedTasks,
    completedSales,
    totalChanges: taskChanges + saleChanges + scheduledChanges,
    scheduledChanges,
    rollbacks,
    taskChanges,
    saleChanges,
    tasksTrend: getTrendLabel(
      countRecordsInSelectedPeriod(tasks),
      countRecordsInPreviousPeriod(tasks),
    ),
    salesTrend: getTrendLabel(
      countRecordsInSelectedPeriod(sales),
      countRecordsInPreviousPeriod(sales),
    ),
    changesTrend: getTrendLabel(
      sumChangesInSelectedPeriod([...tasks, ...sales]),
      sumChangesInPreviousPeriod([...tasks, ...sales]),
    ),
    rollbacksTrend: getTrendLabel(
      countRecordsInSelectedPeriod(rollbackRecords),
      countRecordsInPreviousPeriod(rollbackRecords),
    ),
    tasksChart,
    previousTasksChart,
    salesChart,
    previousSalesChart,
    changesChart,
    previousChangesChart,
    rollbacksChart,
    previousRollbacksChart,
  };
}

function getAnalyticsChartStart(referenceDate = new Date()) {
  const start = new Date(referenceDate);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (ANALYTICS_CHART_DAYS - 1));

  return start;
}

function getPeriodBoundsForRecords(days = ANALYTICS_CHART_DAYS) {
  const currentStart = getAnalyticsChartStart();
  const end = new Date(currentStart);
  end.setDate(currentStart.getDate() + days);
  const previousStart = new Date(currentStart);
  previousStart.setDate(previousStart.getDate() - days);

  return { end, currentStart, previousStart };
}

function isDateInRange(value, start, end) {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date >= start && date < end;
}

function countRecordsInSelectedPeriod(records) {
  const { end, currentStart } = getPeriodBoundsForRecords();
  return records.filter((record) => isDateInRange(getRecordChangeDate(record), currentStart, end)).length;
}

function countRecordsInPreviousPeriod(records) {
  const { currentStart, previousStart } = getPeriodBoundsForRecords();
  return records.filter((record) => isDateInRange(getRecordChangeDate(record), previousStart, currentStart)).length;
}

function sumChangesInSelectedPeriod(records) {
  const { end, currentStart } = getPeriodBoundsForRecords();
  return records.reduce((sum, record) => (
    isDateInRange(getRecordChangeDate(record), currentStart, end)
      ? sum + (getAnalyticsChangeCount(record) || 1)
      : sum
  ), 0);
}

function sumChangesInPreviousPeriod(records) {
  const { currentStart, previousStart } = getPeriodBoundsForRecords();
  return records.reduce((sum, record) => (
    isDateInRange(getRecordChangeDate(record), previousStart, currentStart)
      ? sum + (getAnalyticsChangeCount(record) || 1)
      : sum
  ), 0);
}

function getTrendLabel(currentValue, previousValue) {
  if (!currentValue && !previousValue) return "No changes";
  if (!previousValue) return "New";

  const percent = Math.round(((currentValue - previousValue) / previousValue) * 100);
  return `${percent >= 0 ? "up " : "down "}${Math.abs(percent)}%`;
}

function buildDailySeries(records, getDate, getValue = () => 1, days = ANALYTICS_CHART_DAYS) {
  return buildDailySeriesForPeriod(records, getDate, getValue, getAnalyticsChartStart(), days);
}

function buildDailySeriesForPeriod(records, getDate, getValue = () => 1, startDate, days = ANALYTICS_CHART_DAYS) {
  const start = new Date(startDate || new Date());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + days);
  const buckets = new Map();

  for (let index = 0; index < days; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    buckets.set(formatDateKey(date), 0);
  }

  for (const record of records) {
    const rawDate = getDate(record);
    if (!rawDate) continue;

    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime()) || date < start || date >= end) continue;

    const key = formatDateKey(date);
    buckets.set(key, (buckets.get(key) || 0) + Math.max(0, Number(getValue(record)) || 0));
  }

  return [...buckets.entries()].map(([date, value]) => ({ date, value }));
}

function buildApplyToSections(tasks, sales) {
  return [
    {
      title: "Tasks",
      targets: buildApplyToCards(tasks, "task", TASK_APPLY_TO_OPTIONS),
    },
    {
      title: "Sale",
      targets: buildApplyToCards(sales, "sale", SALE_APPLY_TO_OPTIONS),
    },
  ];
}

function buildApplyToCards(records, kind, options) {
  const grouped = new Map(
    options.map((option) => [
      option.key,
      {
        ...option,
        id: `${kind}-${option.key}`,
        records: 0,
        changes: 0,
        rollbacks: 0,
        lastActivity: null,
        chart: [],
        previousChart: [],
      },
    ]),
  );

  for (const record of records) {
    const key = normalizeApplyScope(record);
    const card = grouped.get(key);
    if (!card) continue;

    const changes = getAnalyticsChangeCount(record);
    card.records += 1;
    card.changes += changes;
    card.rollbacks += hasRollback(record) ? 1 : 0;
    card.lastActivity = getLaterDate(card.lastActivity, getRecordChangeDate(record));
    card.chart.push({
      date: getRecordChangeDate(record),
      value: changes || 1,
    });
  }

  return [...grouped.values()].map((card) => {
    const { currentStart, previousStart } = getPeriodBoundsForRecords();

    return {
      ...card,
      chart: buildDailySeriesForPeriod(card.chart, (item) => item.date, (item) => item.value, currentStart),
      previousChart: buildDailySeriesForPeriod(card.chart, (item) => item.date, (item) => item.value, previousStart),
    };
  });
}

function normalizeApplyScope(record) {
  if (record?.applyTo) return record.applyTo;

  const resources = getObjectValue(record.applyResources);
  const summaryApplyTo = getObjectValue(getSummary(record).applyTo);
  const rawScope = String(
    record.applyScope || resources.scope || summaryApplyTo.scope || "whole_store",
  ).toLowerCase();

  if (rawScope.includes("not_on_sale") || rawScope.includes("not on sale")) {
    return "all_store_products_not_on_sale";
  }
  if (rawScope.includes("variant")) return "selected_products_with_variants";
  if (rawScope.includes("collection")) return "selected_collections";
  if (rawScope.includes("tag")) return "selected_tags";
  if (rawScope.includes("product")) return "selected_products";
  return "whole_store";
}

function getObjectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function getResourceLabel(item, fallback, type) {
  if (item && typeof item === "object") {
    return (
      item.title ||
      item.name ||
      item.label ||
      item.handle ||
      item.id ||
      fallback ||
      humanize(type)
    );
  }

  if (item) return String(item);
  if (fallback) return String(fallback).split("/").pop();
  return humanize(type);
}

function getLaterDate(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return new Date(right) > new Date(left) ? right : left;
}

function buildProductTitleLookup(record) {
  const lookup = new Map();
  const addRecord = (item) => {
    if (!item || typeof item !== "object") return;
    const title =
      item.productTitle ||
      item.title ||
      item.name ||
      item.label ||
      item.product?.title ||
      "";
    if (!title) return;

    [
      item.productId,
      item.id,
      item.gid,
      item.admin_graphql_api_id,
      item.variantId,
      item.product?.id,
    ]
      .filter(Boolean)
      .forEach((id) => lookup.set(String(id), title));
  };

  const resources = getObjectValue(record.applyResources);
  [
    resources.products,
    resources.variants,
    getSummary(record).logs,
    getSummary(record).originals,
    getSummary(record).updatedVariants,
    getSummary(record).marketPrices,
  ].forEach((items) => {
    if (Array.isArray(items)) items.forEach(addRecord);
  });

  return lookup;
}

function getLogTarget(log, record, titleLookup) {
  const title =
    log?.productTitle ||
    titleLookup.get(String(log?.productId || "")) ||
    titleLookup.get(String(log?.variantId || ""));

  if (title) return title;
  if (log?.productId || log?.variantId) return "Product";
  return getMarketText(record);
}

function buildChangeTrend(tasks, sales) {
  const records = Array.isArray(sales)
    ? [
        ...tasks.map((task) => ({ kind: "task", ...task })),
        ...sales.map((sale) => ({ kind: "sale", ...sale })),
      ]
    : Array.isArray(tasks)
      ? tasks
      : [];
  const currentStart = getAnalyticsChartStart();
  const previousStart = new Date(currentStart);
  previousStart.setDate(currentStart.getDate() - ANALYTICS_CHART_DAYS);
  const getRecordValue = (record) => Number(record.value) || getAnalyticsChangeCount(record) || 1;

  return {
    current: buildApplyToDailySeriesForPeriod(records, currentStart, getRecordValue),
    previous: buildApplyToDailySeriesForPeriod(records, previousStart, getRecordValue),
  };
}

function buildChartRecords(tasks, sales) {
  return [
    ...tasks.map((task) => ({
      id: `task-${task.id}`,
      kind: "task",
      date: getRecordChangeDate(task),
      applyTo: normalizeApplyScope(task),
      value: getAnalyticsChangeCount(task) || 1,
    })),
    ...sales.map((sale) => ({
      id: `sale-${sale.id}`,
      kind: "sale",
      date: getRecordChangeDate(sale),
      applyTo: normalizeApplyScope(sale),
      value: getAnalyticsChangeCount(sale) || 1,
    })),
  ].filter((record) => record.date);
}

function buildApplyToDailySeriesForPeriod(records, startDate, getValue = () => 1, days = ANALYTICS_CHART_DAYS) {
  const start = new Date(startDate || new Date());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + days);
  const buckets = new Map();

  for (let index = 0; index < days; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const key = formatDateKey(date);
    buckets.set(key, {
      date: key,
      value: 0,
      applyToBreakdown: {},
    });
  }

  for (const record of records) {
    const rawDate = getRecordChangeDate(record);
    if (!rawDate) continue;

    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime()) || date < start || date >= end) continue;

    const key = formatDateKey(date);
    const bucket = buckets.get(key);
    if (!bucket) continue;

    const value = Math.max(0, Number(getValue(record)) || 0);
    const applyTo = normalizeApplyScope(record);
    bucket.value += value;
    bucket.applyToBreakdown[applyTo] = (bucket.applyToBreakdown[applyTo] || 0) + value;
  }

  return [...buckets.values()];
}

function formatDateKey(value) {
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function isCompletedTask(task) {
  const status = String(task.status || "").toLowerCase();
  return status === "complete" || status === "completed" || status.includes("success");
}

function buildRecentChanges(tasks, sales, shop) {
  const taskRows = tasks.flatMap((task) => {
    const logs = task.auditLogs?.length
      ? task.auditLogs
      : buildSummaryLogs(task, "task");
    const titleLookup = buildProductTitleLookup(task);

    return logs.map((log, logIndex) => ({
      id: `task-${task.id}-${log.id || log.createdAt || log.variantId || logIndex}`,
      type: "Task",
      title: getTaskTitle(task),
      date: log.createdAt || getRecordChangeDate(task),
      target: getLogTarget(log, task, titleLookup),
      targetUrl: getShopifyAdminProductUrl(shop, log),
      change: formatChangeText(log, task),
      status: log.action || log.status || getRecordAnalyticsStatus(task),
      url: `/app/tasks/${task.id}`,
    }));
  });
  const saleRows = sales.flatMap((sale) => {
    const titleLookup = buildProductTitleLookup(sale);
    return buildSummaryLogs(sale, "sale").map((log, logIndex) => ({
      id: `sale-${sale.id}-${log.createdAt || log.variantId || log.productId || logIndex}`,
      type: "Sale",
      title: sale.title || `Sale #${sale.id}`,
      date: log.createdAt || getRecordChangeDate(sale),
      target: getLogTarget(log, sale, titleLookup),
      targetUrl: getShopifyAdminProductUrl(shop, log),
      change: formatChangeText(log, sale),
      status: log.action || log.status || getRecordAnalyticsStatus(sale),
      url: `/app/sales/${sale.id}`,
    }));
  });

  return [...taskRows, ...saleRows]
    .sort((left, right) => new Date(right.date || 0) - new Date(left.date || 0));
}

function getShopifyAdminProductUrl(shop, log) {
  const productId = getShopifyResourceId(
    log?.productId ||
      log?.product?.id ||
      log?.admin_graphql_api_id ||
      log?.productGid,
    "Product",
  );

  if (!shop || !productId) return "";

  return `https://${shop}/admin/products/${productId}`;
}

function getShopifyResourceId(value, resourceType) {
  if (!value) return "";

  const rawValue = String(value);
  const gidMatch = rawValue.match(new RegExp(`gid://shopify/${resourceType}/(\\d+)`));
  if (gidMatch) return gidMatch[1];

  const numericMatch = rawValue.match(/^\d+$/);
  return numericMatch ? numericMatch[0] : "";
}

function buildSummaryLogs(record, kind) {
  const summary = getSummary(record);
  if (Array.isArray(summary.logs) && summary.logs.length) return summary.logs;
  const count = getAnalyticsChangeCount(record);
  if (!count) return [];

  return [
    {
      createdAt: getRecordChangeDate(record),
      status: getRecordAnalyticsStatus(record),
      changes: [
        isPendingScheduledRecord(record)
          ? `${formatInteger(count)} scheduled ${kind === "sale" ? "sale" : "task"} changes`
          : `${formatInteger(count)} ${kind === "sale" ? "sale" : "task"} changes`,
      ],
    },
  ];
}

function getTaskTitle(task) {
  const action = task.priceChange?.action || task.compareAtPriceChange?.action || "";
  if (task.applyChangesTo === "markets") return `Market task #${task.id}`;
  return action ? `${humanize(action)} task #${task.id}` : `Task #${task.id}`;
}

function getTaskDisplayTitle(task) {
  const customTitle = getFirstValue([
    task.title,
    task.name,
    task.changeTitle,
    task.taskTitle,
  ]);

  if (customTitle) return customTitle;

  const changes = [
    formatChangePayload(task.priceChange, "price"),
    formatChangePayload(task.compareAtPriceChange, "compare at price"),
    formatChangePayload(task.costPerItemChange, "cost per item"),
  ].filter(Boolean);

  if (changes.length) return changes.join(" ");

  return getTaskTitle(task);
}

function formatChangePayload(change, label) {
  const action = String(change?.action || "").toLowerCase();
  if (!action) return "";

  if (action === "reset_compare_at_price") return "Reset compare at price";
  if (action === "reset_cost_per_item") return "Reset cost per item";
  if (action === "set_to_price") return "Set compare at price to price";
  if (action === "set_to_compare_at_price") return "Set price to compare at price";
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
      ? change.amount
      : change.percent
        ? `${change.percent}%`
        : change.amount;

  if (action === "set_new_value") {
    return value ? `Set ${label} to ${value}` : `Set ${label}`;
  }

  const valueText = value ? ` by ${value}` : "";

  return `${actionLabel} ${label}${valueText}`;
}

function getFirstValue(values) {
  return values.find((value) => value != null && value !== "");
}

function formatChangeText(log, record) {
  if (Array.isArray(log?.changes) && log.changes.length) {
    return log.changes.slice(0, 2).join("; ");
  }

  const previous = log?.previousPrice ?? log?.oldPrice;
  const next = log?.newPrice;
  if (previous != null || next != null) {
    return `Price: ${formatBlank(previous)} -> ${formatBlank(next)}`;
  }

  return `${formatInteger(getAnalyticsChangeCount(record))} changes`;
}

function buildRollbackRows(tasks, sales) {
  const taskRows = tasks
    .filter(hasRollback)
    .map((task) => {
      const summary = getSummary(task);
      const rollback = summary.rollback || {};
      return {
        id: `task-rollback-${task.id}`,
        type: "Task",
        title: getTaskDisplayTitle(task),
        date: summary.rollbackCompletedAt || rollback.completedAt || task.updatedAt,
        changes: firstNumber(rollback.totalPriceChanges, rollback.updatedVariants, summary.rollbackUpdatedVariants),
        status: rollback.status || summary.rollbackStatus || task.status,
        url: `/app/tasks/${task.id}`,
      };
    });
  const saleRows = sales
    .filter(hasRollback)
    .map((sale) => {
      const summary = getSummary(sale);
      const rollback = summary.rollback || summary.ended || {};
      return {
        id: `sale-rollback-${sale.id}`,
        type: "Sale",
        title: sale.title || `Sale #${sale.id}`,
        date: summary.rollbackCompletedAt || rollback.completedAt || sale.updatedAt,
        changes: firstNumber(rollback.totalPriceChanges, rollback.updatedVariants, summary.rollbackUpdatedVariants),
        status: rollback.status || summary.rollbackStatus || sale.status,
        url: `/app/sales/${sale.id}`,
      };
    });

  return [...taskRows, ...saleRows]
    .sort((left, right) => new Date(right.date || 0) - new Date(left.date || 0))
    .slice(0, ROLLBACK_LIMIT);
}

function humanize(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatBlank(value) {
  if (value == null || value === "") return "blank";
  return String(value);
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatShortDate(value) {
  if (!value) return "-";
  const date = parseLocalDate(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatLongDate(value) {
  if (!value) return "-";
  const date = parseLocalDate(value);
  if (Number.isNaN(date.getTime())) return "-";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function statusTone(status) {
  const value = String(status || "").toLowerCase();
  if (value.includes("fail") || value.includes("error")) return "critical";
  if (value.includes("cancel") || value.includes("rollback")) return "warning";
  if (value.includes("complete") || value.includes("applied") || value.includes("active")) return "success";
  return "info";
}

function parseLocalDate(value) {
  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }
  }

  return new Date(value);
}

function buildDonutGradient(stats) {
  const task = Number(stats.taskChanges) || 0;
  const sale = Number(stats.saleChanges) || 0;
  const scheduled = Number(stats.scheduledChanges) || 0;
  const rollback = Number(stats.rollbacks) || 0;
  const total = task + sale + scheduled + rollback;

  if (!total) return "conic-gradient(#e3e6ea 0 100%)";

  const taskEnd = (task / total) * 100;
  const saleEnd = taskEnd + (sale / total) * 100;
  const scheduledEnd = saleEnd + (scheduled / total) * 100;
  return `conic-gradient(#10a37f 0 ${taskEnd}%, #6d5dfc ${taskEnd}% ${saleEnd}%, ${scheduleSummaryColor} ${saleEnd}% ${scheduledEnd}%, #f59e0b ${scheduledEnd}% 100%)`;
}

function MetricCard({
  title,
  value,
  subtitle,
  color,
  icon,
  trend = "No changes",
}) {
  return (
    <div style={metricCardStyle}>
      <div style={metricCardInnerStyle}>
      <Card>
        <div style={metricCardContentStyle}>
          <InlineStack align="start" blockAlign="center" gap="300" wrap={false}>
            <div style={{ ...metricIconStyle, background: color.background, color: color.foreground }}>
              <Icon source={icon} />
            </div>
            <div style={metricSummaryStyle}>
              <InlineStack gap="150" blockAlign="baseline" wrap={false}>
                <Text as="span" fontWeight="semibold">
                  {title}
                </Text>
                <Text as="span" variant="headingLg">
                  {value}
                </Text>
                <Text as="span" fontWeight="semibold">
                  {subtitle}
                </Text>
              </InlineStack>
            </div>
          </InlineStack>
          <Text as="span" fontWeight="semibold">
            Last 30 days
          </Text>
        </div>
      </Card>
      </div>
    </div>
  );
}

function formatDateChartPeriod(data = []) {
  const first = data[0]?.date;
  const last = data[data.length - 1]?.date;

  if (!first || !last) {
    return "";
  }

  return `${formatShortDate(first)}-${formatLongDate(last)}`;
}

function MetricSparkline({ color, data = [], flat = false }) {
  const safeData = Array.isArray(data) ? data : [];
  const values = safeData.length ? safeData.map((point) => Math.max(0, Number(point.value) || 0)) : [0];
  const maxValue = Math.max(1, ...values);
  const points = values.map((value, index) => {
    const x = 8 + index * (104 / Math.max(1, values.length - 1));
    const y = 8 + 38 - (value / maxValue) * 38;
    return { x, y };
  });
  const linePoints = points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const areaPoints = `${linePoints} 112,54 8,54`;

  if (flat || !values.some(Boolean)) {
    return (
      <svg viewBox="0 0 120 56" role="img" aria-label="No change chart" style={metricSparklineStyle}>
        <line x1="8" y1="30" x2="112" y2="30" stroke={color} strokeWidth="1" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 120 56" role="img" aria-label="Trend chart" style={metricSparklineStyle}>
      <polygon points={areaPoints} fill={color} opacity="0.08" />
      <polyline
        points={linePoints}
        fill="none"
        stroke={color}
        strokeWidth="1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function ApplyTargetsSection({ sections = [] }) {
  const safeSections = Array.isArray(sections) ? sections : [];

  return (
    <BlockStack gap="500">
      {safeSections.map((section) => {
        const targets = Array.isArray(section.targets) ? section.targets : [];

        return (
        <BlockStack key={section.title} gap="300">
          <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
            <BlockStack gap="050" paddingBlockStart="300">
              <Text as="h2" variant="headingMd">
                {section.title}
              </Text>
            </BlockStack>
            <Badge tone="info">{formatInteger(targets.length)} boxes</Badge>
          </InlineStack>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 3 }} gap="400">
            {targets.map((target) => (
              <ApplyTargetCard key={target.id} target={target} />
            ))}
          </InlineGrid>
        </BlockStack>
        );
      })}
    </BlockStack>
  );
}

function ApplyTargetCard({ target = {} }) {
  const icon = getApplyTargetIcon(target.type);

  return (
    <div style={{ position: "relative" }}>
      <Card>
        <BlockStack gap="400">
          <InlineStack align="space-between" blockAlign="start" gap="300">
            <InlineStack gap="300" blockAlign="center">
              <Box
                background="bg-fill-success-secondary"
                borderRadius="300"
                color="text-success"
                padding="300"
              >
                <Icon source={icon} />
              </Box>
              <BlockStack gap="050">
                <Text as="h3" variant="headingSm" truncate>
                  {target.label}
                </Text>
                <Text as="span" tone="subdued">
                  {formatInteger(target.records)} record{target.records === 1 ? "" : "s"}
                </Text>
              </BlockStack>
            </InlineStack>
            <Box color="text-info">
              <Icon source={ChartHistogramGrowthIcon} />
            </Box>
          </InlineStack>
          <InlineStack align="space-between" blockAlign="end" gap="300">
            <BlockStack gap="050">
              <Text as="p" variant="headingLg">
                {formatInteger(target.changes)}
              </Text>
              <Text as="span" tone="subdued">
                changes
              </Text>
            </BlockStack>
            <BlockStack gap="050" inlineAlign="end">
              <Text as="span">
                {formatInteger(target.rollbacks)} rollback{target.rollbacks === 1 ? "" : "s"}
              </Text>
              <Text as="span" tone="subdued">
                {formatDate(target.lastActivity)}
              </Text>
            </BlockStack>
          </InlineStack>
        </BlockStack>
      </Card>
    </div>
  );
}

function getApplyTargetIcon(type) {
  if (type === "collection") return CollectionIcon;
  if (type === "market") return MarketsIcon;
  if (type === "store") return StoreIcon;
  return ProductIcon;
}

function ChangeTrendCard({
  records = [],
  yearOptions = [],
}) {
  const [selectedType, setSelectedType] = useState("all");
  const [selectedYear, setSelectedYear] = useState("all");
  const [selectedApplyTo, setSelectedApplyTo] = useState("all");
  const applyToOptions = getApplyToFilterOptions(selectedType);
  const normalizedApplyTo = applyToOptions.some((option) => option.value === selectedApplyTo)
    ? selectedApplyTo
    : "all";
  const filteredRecords = useMemo(
    () => filterChartRecords(records, selectedType, selectedYear, normalizedApplyTo),
    [records, selectedType, selectedYear, normalizedApplyTo],
  );
  const data = useMemo(() => buildChangeTrend(filteredRecords), [filteredRecords]);
  const currentData = Array.isArray(data?.current) ? data.current : [];
  const previousData = Array.isArray(data?.previous) ? data.previous : [];
  const total = currentData.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  const applyToLabel = getApplyToFilterLabel(normalizedApplyTo, selectedType);
  const breakdownOptions = getApplyToBreakdownOptions(selectedType, normalizedApplyTo);

  const handleTypeChange = (value) => {
    setSelectedType(value);
    const nextApplyToOptions = getApplyToFilterOptions(value);
    if (!nextApplyToOptions.some((option) => option.value === selectedApplyTo)) {
      setSelectedApplyTo("all");
    }
  };

  return (
    <PeriodComparisonChart
      title="Changes over time"
      value={total}
      currentData={currentData}
      previousData={previousData}
      currentPeriodLabel={formatDateChartPeriod(currentData)}
      previousPeriodLabel={formatDateChartPeriod(previousData)}
      applyToLabel={applyToLabel}
      applyToOptions={breakdownOptions}
      controls={(
        <InlineStack gap="300" blockAlign="center" wrap>
          <div style={{ minWidth: 180 }}>
            <Select
              label="Type"
              options={RECORD_TYPE_OPTIONS}
              value={selectedType}
              onChange={handleTypeChange}
            />
          </div>
          <div style={{ minWidth: 160 }}>
            <Select
              label="Year"
              options={yearOptions}
              value={selectedYear}
              onChange={setSelectedYear}
            />
          </div>
          <div style={{ minWidth: 260 }}>
            <Select
              label="Apply to"
              options={applyToOptions}
              value={normalizedApplyTo}
              onChange={setSelectedApplyTo}
            />
          </div>
        </InlineStack>
      )}
    />
  );
}

function SummaryCard({ stats }) {
  const total = Math.max(1, stats.totalChanges + stats.rollbacks);
  const taskPercent = Math.round((stats.taskChanges / total) * 100);
  const salePercent = Math.round((stats.saleChanges / total) * 100);
  const scheduledPercent = Math.round((stats.scheduledChanges / total) * 100);
  const rollbackPercent = Math.round((stats.rollbacks / total) * 100);

  return (
    <Card>
      <BlockStack gap="500">
        <Text as="h2" variant="headingMd">
          Change summary
        </Text>
        <InlineStack align="space-around" blockAlign="center" gap="600" wrap>
          <div style={donutStyle(stats)}>
            <div style={donutInnerStyle}>
              <BlockStack gap="0" inlineAlign="center">
                <Text as="p" variant="headingLg">
                  {formatInteger(stats.totalChanges)}
                </Text>
                <Text as="span" tone="subdued">
                  Changes
                </Text>
              </BlockStack>
            </div>
          </div>
          <BlockStack gap="300">
            <LegendRow color="#10a37f" label="Task changes" value={stats.taskChanges} percent={taskPercent} />
            <LegendRow color="#6d5dfc" label="Sale changes" value={stats.saleChanges} percent={salePercent} />
            <LegendRow color={scheduleSummaryColor} label="Scheduled changes" value={stats.scheduledChanges} percent={scheduledPercent} />
            <LegendRow color="#f59e0b" label="Rollbacks" value={stats.rollbacks} percent={rollbackPercent} />
          </BlockStack>
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function LegendRow({ color, label, value, percent }) {
  return (
    <InlineStack gap="300" blockAlign="center" align="space-between">
      <InlineStack gap="200" blockAlign="center">
        <span style={{ width: 12, height: 12, borderRadius: 999, background: color }} />
        <Text as="span">{label}</Text>
      </InlineStack>
      <Text as="span" tone="subdued">
        {formatInteger(value)} ({percent}%)
      </Text>
    </InlineStack>
  );
}

function RecentChangesTable({ rows = [] }) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const [selectedTab, setSelectedTab] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const taskCount = safeRows.filter((row) => row.type === "Task").length;
  const saleCount = safeRows.filter((row) => row.type === "Sale").length;
  const tabs = useMemo(
    () => [
      { id: "tasks", content: `Task (${formatInteger(taskCount)})` },
      { id: "sales", content: `Sale (${formatInteger(saleCount)})` },
    ],
    [saleCount, taskCount],
  );
  const selectedType = selectedTab === 0 ? "Task" : "Sale";
  const visibleRows = safeRows
    .filter((row) => row.type === selectedType)
    .filter((row) => matchesRecentChangeSearch(row, query));
  const totalPages = Math.max(1, Math.ceil(visibleRows.length / RECENT_CHANGES_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paginatedRows = visibleRows.slice(
    (currentPage - 1) * RECENT_CHANGES_PAGE_SIZE,
    currentPage * RECENT_CHANGES_PAGE_SIZE,
  );
  const handleTabSelect = (index) => {
    setSelectedTab(index);
    setPage(1);
  };
  const handleQueryChange = (value) => {
    setQuery(value);
    setPage(1);
  };

  return (
    <Card padding="0">
      <Box padding="400" borderBlockEndWidth="025" borderColor="border">
        <BlockStack gap="300">
          <Text as="h2" variant="headingMd">
            Recent changes
          </Text>
          <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
            <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabSelect} />
            <div style={{ minWidth: 280, flex: "0 1 380px" }}>
              <TextField
                label="Search recent changes"
                labelHidden
                type="search"
                value={query}
                onChange={handleQueryChange}
                placeholder="Search recent changes"
                clearButton
                onClearButtonClick={() => handleQueryChange("")}
                autoComplete="off"
              />
            </div>
          </InlineStack>
        </BlockStack>
      </Box>
      <IndexTable
        resourceName={{ singular: "change", plural: "changes" }}
        itemCount={paginatedRows.length}
        selectable={false}
        headings={[
          { title: "Title" },
          { title: "Changes" },
          { title: "Date" },
          { title: "Status" },
        ]}
      >
        {paginatedRows.map((row, index) => (
          <IndexTable.Row id={row.id} key={row.id} position={index}>
            <IndexTable.Cell>
              {row.targetUrl ? (
                <Link url={row.targetUrl} removeUnderline>
                  {row.target}
                </Link>
              ) : (
                row.target
              )}
            </IndexTable.Cell>
            <IndexTable.Cell>
              <Link url={row.url} removeUnderline>
                {row.change}
              </Link>
            </IndexTable.Cell>
            <IndexTable.Cell>{formatDate(row.date)}</IndexTable.Cell>
            <IndexTable.Cell>
              <Badge tone={statusTone(row.status)}>{humanize(row.status || "Updated")}</Badge>
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
      {!visibleRows.length ? (
        <EmptyTable
          message={
            query.trim()
              ? `No ${selectedType.toLowerCase()} changes match your search.`
              : `No ${selectedType.toLowerCase()} changes found.`
          }
        />
      ) : null}
      {visibleRows.length > RECENT_CHANGES_PAGE_SIZE ? (
        <Box padding="400" borderBlockStartWidth="025" borderColor="border">
          <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
            <Text as="span" tone="subdued">
              {formatInteger((currentPage - 1) * RECENT_CHANGES_PAGE_SIZE + 1)}-
              {formatInteger(Math.min(currentPage * RECENT_CHANGES_PAGE_SIZE, visibleRows.length))} of{" "}
              {formatInteger(visibleRows.length)}
            </Text>
            <Pagination
              hasPrevious={currentPage > 1}
              onPrevious={() => setPage((value) => Math.max(1, value - 1))}
              hasNext={currentPage < totalPages}
              onNext={() => setPage((value) => Math.min(totalPages, value + 1))}
            />
          </InlineStack>
        </Box>
      ) : null}
    </Card>
  );
}

function matchesRecentChangeSearch(row, query) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  return [
    row.change,
    row.target,
    row.title,
    row.status,
    row.type,
    formatDate(row.date),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalizedQuery));
}

function RollbacksTable({ rows = [] }) {
  const safeRows = Array.isArray(rows) ? rows : [];

  return (
    <Card padding="0">
      <Box padding="400">
        <Text as="h2" variant="headingMd">
          Recent rollbacks
        </Text>
      </Box>
      <IndexTable
        resourceName={{ singular: "rollback", plural: "rollbacks" }}
        itemCount={safeRows.length}
        selectable={false}
        headings={[
          { title: "Title" },
          { title: "Changes" },
          { title: "Date" },
          { title: "Status" },
        ]}
      >
        {safeRows.map((row, index) => (
          <IndexTable.Row id={row.id} key={row.id} position={index}>
            <IndexTable.Cell>
              <div style={rollbackTitleColumnStyle}>
                <BlockStack gap="050">
                  <Link url={row.url} removeUnderline>
                    {row.title}
                  </Link>
                  <Text as="span" tone="subdued">
                    {row.type}
                  </Text>
                </BlockStack>
              </div>
            </IndexTable.Cell>
            <IndexTable.Cell>{formatInteger(row.changes)}</IndexTable.Cell>
            <IndexTable.Cell>{formatDate(row.date)}</IndexTable.Cell>
            <IndexTable.Cell>
              <Badge tone={statusTone(row.status)}>{humanize(row.status || "Rolled back")}</Badge>
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
      {!safeRows.length ? <EmptyTable message="No rollbacks found for this filter." /> : null}
    </Card>
  );
}

function EmptyTable({ message }) {
  return (
    <Box padding="600">
      <BlockStack gap="200" inlineAlign="center">
        <Text as="p" variant="headingSm" alignment="center">
          {message}
        </Text>
        <Text as="p" tone="subdued" alignment="center">
          Try changing the type or year filter.
        </Text>
      </BlockStack>
    </Box>
  );
}

export default function AnalysisPage() {
  const loaderData = useLoaderData();
  const {
    availableYears = [],
    stats = {},
    recentChanges = [],
    rollbackRows = [],
    applyToSections = [],
    chartRecords = [],
  } = loaderData || {};
  const yearOptions = [
    { label: "All years", value: "all" },
    ...(Array.isArray(availableYears) ? availableYears : []).map((year) => ({ label: year, value: year })),
  ];

  useEffect(() => {
    const url = new URL(window.location.href);
    const chartFilterKeys = ["type", "year", "applyTo"];
    const hasChartFilterParams = chartFilterKeys.some((key) => url.searchParams.has(key));

    if (!hasChartFilterParams) return;

    chartFilterKeys.forEach((key) => url.searchParams.delete(key));
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);

  return (
    <>
      <TitleBar title="Boltr Bulk Price Editor" />
      <Page fullWidth>
        <div style={pageContentStyle}>
        <BlockStack gap="500">
          <Text as="h1" variant="headingXl">
            Analytics
          </Text>

          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            <MetricCard
              title="Tasks"
              value={formatInteger(stats.tasks)}
              subtitle="items"
              color={{ background: "#dff7ee", foreground: "#008060" }}
              icon={ProductIcon}
              trend={stats.tasksTrend}
              chart={stats.tasksChart}
              previousChart={stats.previousTasksChart}
            />
            <MetricCard
              title="Sales"
              value={formatInteger(stats.sales)}
              subtitle="items"
              color={{ background: "#ede9fe", foreground: "#5b21b6" }}
              icon={DiscountIcon}
              trend={stats.salesTrend}
              chart={stats.salesChart}
              previousChart={stats.previousSalesChart}
            />
            <MetricCard
              title="Changes"
              value={formatInteger(stats.totalChanges)}
              subtitle="items"
              color={{ background: "#fff7ed", foreground: "#c2410c" }}
              icon={ChartHistogramGrowthIcon}
              trend={stats.changesTrend}
              chart={stats.changesChart}
              previousChart={stats.previousChangesChart}
            />
            <MetricCard
              title="Rollbacks"
              value={formatInteger(stats.rollbacks)}
              subtitle="records"
              color={{ background: "#dbeafe", foreground: "#1d4ed8" }}
              icon={ProductReturnIcon}
              trend={stats.rollbacksTrend}
              chart={stats.rollbacksChart}
              previousChart={stats.previousRollbacksChart}
            />
          </InlineGrid>

          <ChangeTrendCard
            records={chartRecords}
            yearOptions={yearOptions}
          />

          <InlineGrid columns={{ xs: 1, lg: "2fr 1fr" }} gap="500">
            <RecentChangesTable rows={recentChanges} />
            <BlockStack gap="500">
              <SummaryCard stats={stats} />
              <RollbacksTable rows={rollbackRows} />
            </BlockStack>
          </InlineGrid>
        </BlockStack>
        </div>
      </Page>
    </>
  );
}
