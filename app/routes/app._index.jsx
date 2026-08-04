// app/routes/app._index.jsx
import { json } from "@remix-run/node";
import {
  Page,
  Layout,
  Card,
  Icon,
  Text,
  Button,
  InlineGrid,
  InlineStack,
  BlockStack,
  Box,
  Link,
} from "@shopify/polaris";
import {
  ChartHistogramGrowthIcon,
  ClockIcon,
  DiscountIcon,
  ProductIcon,
} from "@shopify/polaris-icons";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import {
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
} from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { withShopifyEmbeddedParams } from "../lib/shopify-embedded-url";
import { normalizeSaleStatus, SALE_STATUS } from "../lib/sale-status";

const statsRowStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "5px 0",
};

const statsValueStyle = {
  fontWeight: 600,
  color: "#202223",
};

const dashboardMetricIconStyle = {
  width: 52,
  height: 52,
  borderRadius: 12,
  display: "grid",
  placeItems: "center",
  flex: "0 0 52px",
};

const dashboardMetricCardStyle = {
  minHeight: 132,
  height: 132,
  display: "flex",
  flexDirection: "column",
  position: "relative",
};

const dashboardMetricCardInnerStyle = {
  height: "100%",
};

const dashboardMetricContentStyle = {
  height: 92,
  display: "flex",
  flexDirection: "column",
  justifyContent: "space-between",
  overflow: "hidden",
};

const dashboardSparklineStyle = {
  width: 120,
  height: 56,
  flex: "0 0 120px",
};

const dashboardMetricSummaryStyle = {
  minHeight: 52,
  flex: "1 1 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-start",
  textAlign: "left",
  minWidth: 0,
};

const dashboardChartOverlayStyle = {
  position: "fixed",
  left: "18%",
  top: "70%",
  width: "min(820px, calc(100vw - 64px))",
  transform: "translate(0%, -50%)",
  zIndex: 50,
  background: "#ffffff",
  borderRadius: 8,
};

const dashboardChartPanelStyle = {
  background: "#ffffff",
  borderRadius: 8,
};

const dashboardChartSvgStyle = {
  width: "100%",
  height: 260,
  display: "block",
  overflow: "visible",
  background: "#ffffff",
};

const dashboardChartTooltipStyle = {
  position: "absolute",
  pointerEvents: "none",
  minWidth: 150,
  padding: 8,
  borderRadius: 8,
  background: "#ffffff",
  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.16)",
  border: "1px solid #e3e3e3",
};

const dashboardChartLegendDotStyle = {
  width: 10,
  height: 10,
  borderRadius: "50%",
  display: "inline-block",
};

const DASHBOARD_CHART_DAYS = 31;

const taskStatDefinitions = [
  { id: "all", label: "All tasks", url: "/app/tasks" },
  { id: "completed", label: "Completed", url: "/app/tasks?status=completed" },
  { id: "canceled", label: "Canceled", url: "/app/tasks?status=cancelled" },
];

const saleStatDefinitions = [
  { id: "all", label: "All sales", url: "/app/sales" },
  { id: "scheduled", label: "Scheduled", url: "/app/sales?status=scheduled" },
  { id: "completed", label: "Completed", url: "/app/sales?status=Canceled" },
];

const recommendedApps = [
  {
    name: "Fomoify Sales Popup & Proof",
    description:
      "Increase trust using real-time sales popups and conversion proof nudges.",
    category: "Social Proof",
    url: "https://apps.shopify.com/fomoify-sales-popup-proof",
    image: "/image/CKapsur_zpUDEAE=.png",
  },
  {
    name: "MixBox - Box & Bundle Builder",
    description:
      "Build custom bundles and boxed products to increase average order value.",
    category: "Bundle",
    url: "https://apps.shopify.com/mixbox-box-bundle-builder",
    image: "/image/CL-nruWY_pMDEAE=.png",
  },
  {
    name: "Nex AI SEO Product Description",
    description:
      "Generate SEO-friendly content to improve visibility and conversion.",
    category: "SEO",
    url: "https://apps.shopify.com/ai-seo-product-description",
    image: "/image/CJbj1a_i9pQDEAE=.png",
  },
  {
    name: "CartLift: Cart Drawer & Upsell",
    description:
      "Create a high-converting cart drawer with upsells and progress offers.",
    category: "Upsell",
    url: "https://apps.shopify.com/cartlift-slide-cart-drawer-upsell",
    image: "/image/b55a28208623440fd6a8987892e4aec3_200x200.png",
  },
];

function taskMatchesStatus(task, statusId) {
  if (statusId === "all") {
    return true;
  }

  const status = String(task.status || "").toLowerCase();

  if (statusId === "completed") {
    return (
      status === "complete" ||
      status.includes("completed") ||
      status.includes("success")
    );
  }

  if (statusId === "canceled") {
    return (
      status.includes("cancel") ||
      status.includes("rollback") ||
      status.includes("rolled back") ||
      status.includes("failed") ||
      status.includes("error")
    );
  }

  return false;
}

function saleMatchesStatus(sale, statusId) {
  if (statusId === "all") {
    return true;
  }

  const status = normalizeSaleStatus(sale.status);

  if (statusId === "completed") {
    return status === SALE_STATUS.COMPLETED;
  }

  if (statusId === "scheduled") {
    return status === SALE_STATUS.SCHEDULED;
  }

  return status === statusId;
}

function buildStats(definitions, records, matcher) {
  return definitions.map((definition) => ({
    ...definition,
    value: records.filter((record) => matcher(record, definition.id)).length,
  }));
}

function getExecutionSummary(record) {
  return record?.executionSummary &&
    typeof record.executionSummary === "object" &&
    !Array.isArray(record.executionSummary)
    ? record.executionSummary
    : {};
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      return number;
    }
  }

  return 0;
}

function getRecordChangeCount(record) {
  const summary = getExecutionSummary(record);
  const rollback = getExecutionSummary({ executionSummary: summary.rollback });
  const ended = getExecutionSummary({ executionSummary: summary.ended });
  const logChanges = Array.isArray(summary.logs)
    ? summary.logs.reduce(
        (sum, log) => sum + Math.max(1, Array.isArray(log?.changes) ? log.changes.length : 0),
        0,
      )
    : undefined;

  return firstFiniteNumber(
    summary.totalPriceChanges,
    summary.updatedVariants,
    summary.variantUpdates,
    summary.updatedInventoryItems,
    summary.addedVariants,
    summary.removedVariants,
    summary.taggedProducts,
    rollback.updatedVariants,
    rollback.totalPriceChanges,
    ended.updatedVariants,
    ended.totalPriceChanges,
    logChanges,
  );
}

function formatInteger(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatSavedTime(totalChanges) {
  const totalMinutes = Math.round(totalChanges * 0.5);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function getPeriodBounds() {
  const now = new Date();
  const currentStart = new Date(now);
  currentStart.setDate(currentStart.getDate() - 30);
  const previousStart = new Date(now);
  previousStart.setDate(previousStart.getDate() - 60);

  return { now, currentStart, previousStart };
}

function isInRange(date, start, end) {
  if (!date) {
    return false;
  }

  const value = new Date(date).getTime();
  return value >= start.getTime() && value < end.getTime();
}

function countRecordsInRange(records, start, end) {
  return records.filter((record) => isInRange(record.createdAt, start, end)).length;
}

function sumChangesInRange(records, start, end) {
  return records.reduce((sum, record) => {
    if (!isInRange(record.createdAt, start, end)) {
      return sum;
    }

    return sum + getRecordChangeCount(record);
  }, 0);
}

function getTrendLabel(currentValue, previousValue) {
  if (!currentValue && !previousValue) {
    return "No changes";
  }

  if (!previousValue) {
    return currentValue ? "New" : "No changes";
  }

  const percent = Math.round(((currentValue - previousValue) / previousValue) * 100);
  return `${percent >= 0 ? "up " : "down "}${Math.abs(percent)}%`;
}

function buildDailySeries(records, getDate, getValue = () => 1, days = DASHBOARD_CHART_DAYS) {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);

  return buildDailySeriesForPeriod(records, getDate, getValue, start, days);
}

function buildDailySeriesForPeriod(records, getDate, getValue = () => 1, startDate, days = DASHBOARD_CHART_DAYS) {
  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + days);
  const buckets = new Map();

  for (let index = 0; index < days; index += 1) {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    buckets.set(date.toISOString().slice(0, 10), 0);
  }

  for (const record of records) {
    const rawDate = getDate(record);
    if (!rawDate) continue;

    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime()) || date < start || date >= end) continue;

    const key = date.toISOString().slice(0, 10);
    buckets.set(key, (buckets.get(key) || 0) + Math.max(0, Number(getValue(record)) || 0));
  }

  return [...buckets.entries()].map(([date, value]) => ({ date, value }));
}

function buildOverviewStats(tasks, sales, taskAuditLogs, totalTaskChangesCount) {
  const { now, currentStart, previousStart } = getPeriodBounds();
  const currentSeriesStart = new Date(currentStart);
  currentSeriesStart.setHours(0, 0, 0, 0);
  const previousSeriesStart = new Date(previousStart);
  previousSeriesStart.setHours(0, 0, 0, 0);
  const totalTaskChanges = totalTaskChangesCount ?? taskAuditLogs.length;
  const totalSaleChanges = sales.reduce(
    (sum, sale) => sum + getRecordChangeCount(sale),
    0,
  );
  const totalChanges = totalTaskChanges + totalSaleChanges;
  const currentTaskChanges = countRecordsInRange(taskAuditLogs, currentStart, now);
  const previousTaskChanges = countRecordsInRange(taskAuditLogs, previousStart, currentStart);
  const currentSaleChanges = sumChangesInRange(sales, currentStart, now);
  const previousSaleChanges = sumChangesInRange(sales, previousStart, currentStart);
  const currentChanges = currentTaskChanges + currentSaleChanges;
  const previousChanges = previousTaskChanges + previousSaleChanges;
  const changeRecords = [
    ...taskAuditLogs.map((log) => ({ createdAt: log.createdAt, value: 1 })),
    ...sales.map((sale) => ({
      createdAt: sale.createdAt,
      value: getRecordChangeCount(sale),
    })),
  ];
  const changesChart = buildDailySeries(
    changeRecords,
    (record) => record.createdAt,
    (record) => record.value,
  );
  const previousChangesChart = buildDailySeriesForPeriod(
    changeRecords,
    (record) => record.createdAt,
    (record) => record.value,
    previousSeriesStart,
  );
  const tasksChart = buildDailySeriesForPeriod(tasks, (task) => task.createdAt, () => 1, currentSeriesStart);
  const previousTasksChart = buildDailySeriesForPeriod(tasks, (task) => task.createdAt, () => 1, previousSeriesStart);
  const salesChart = buildDailySeriesForPeriod(sales, (sale) => sale.createdAt, () => 1, currentSeriesStart);
  const previousSalesChart = buildDailySeriesForPeriod(sales, (sale) => sale.createdAt, () => 1, previousSeriesStart);
  const savedTimeChart = changesChart.map((point) => ({
    ...point,
    value: Math.round(point.value * 0.5),
  }));
  const previousSavedTimeChart = previousChangesChart.map((point) => ({
    ...point,
    value: Math.round(point.value * 0.5),
  }));

  return {
    tasks: tasks.length,
    sales: sales.length,
    changes: totalChanges,
    totalChanges: formatInteger(totalChanges),
    savedTime: formatSavedTime(totalChanges),
    tasksTrend: getTrendLabel(
      countRecordsInRange(tasks, currentStart, now),
      countRecordsInRange(tasks, previousStart, currentStart),
    ),
    salesTrend: getTrendLabel(
      countRecordsInRange(sales, currentStart, now),
      countRecordsInRange(sales, previousStart, currentStart),
    ),
    changesTrend: getTrendLabel(currentChanges, previousChanges),
    savedTimeTrend: getTrendLabel(
      Math.round(currentChanges * 0.5),
      Math.round(previousChanges * 0.5),
    ),
    tasksChart,
    previousTasksChart,
    salesChart,
    previousSalesChart,
    changesChart,
    previousChangesChart,
    savedTimeChart,
    previousSavedTimeChart,
  };
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const { previousStart } = getPeriodBounds();

  const [tasks, sales, taskAuditLogCount, taskAuditLogs] = await Promise.all([
    db.task.findMany({
      where: { shop: session.shop },
      select: { status: true, executionSummary: true, createdAt: true },
    }),
    db.sale.findMany({
      where: { shop: session.shop },
      select: { status: true, executionSummary: true, createdAt: true },
    }),
    db.taskAuditLog.count({
      where: { shop: session.shop, action: "applied" },
    }),
    db.taskAuditLog.findMany({
      where: {
        shop: session.shop,
        action: "applied",
        createdAt: { gte: previousStart },
      },
      select: { createdAt: true },
    }),
  ]);

  return json({
    overviewStats: buildOverviewStats(tasks, sales, taskAuditLogs, taskAuditLogCount),
    taskStats: buildStats(taskStatDefinitions, tasks, taskMatchesStatus),
    saleStats: buildStats(saleStatDefinitions, sales, saleMatchesStatus),
  });
};

function MetricCard({
  title,
  value,
  subtitle,
  icon,
  color,
  trend = "No changes",
}) {
  return (
    <div style={dashboardMetricCardStyle}>
      <div style={dashboardMetricCardInnerStyle}>
      <Card>
      <div style={dashboardMetricContentStyle}>
        <InlineStack align="start" blockAlign="center" gap="300" wrap={false}>
          <div style={{ ...dashboardMetricIconStyle, background: color.background, color: color.foreground }}>
            <Icon source={icon} />
          </div>
          <div style={dashboardMetricSummaryStyle}>
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

function DashboardMetricChart({ title, color, data = [], previousData = [] }) {
  const [hoveredIndex, setHoveredIndex] = useState(null);
  const chartWidth = 720;
  const chartHeight = 230;
  const padding = { top: 18, right: 16, bottom: 46, left: 46 };
  const safeData = normalizeDashboardChartData(data);
  const safePreviousData = normalizeDashboardChartData(previousData);
  const maxValue = Math.max(
    1,
    ...safeData.map((point) => point.value),
    ...safePreviousData.map((point) => point.value),
  );
  const plotWidth = chartWidth - padding.left - padding.right;
  const plotHeight = chartHeight - padding.top - padding.bottom;
  const points = buildDashboardChartPoints(safeData, maxValue, chartWidth, chartHeight, padding);
  const previousPoints = buildDashboardChartPoints(safePreviousData, maxValue, chartWidth, chartHeight, padding);
  const activeIndex = hoveredIndex ?? safeData.length - 1;
  const activePoint = points[activeIndex];
  const activeData = safeData[activeIndex];
  const activePreviousData = safePreviousData[activeIndex];
  const ticks = Array.from({ length: 4 }, (_, index) => Math.round((maxValue / 3) * index));
  const labelIndexes = getDashboardChartLabelIndexes(safeData.length);
  const tooltipLeft = activePoint ? `${Math.min(Math.max((activePoint.x / chartWidth) * 100, 8), 78)}%` : "50%";
  const tooltipTop = activePoint ? Math.max(12, activePoint.y - 74) : 20;

  const handlePointerMove = (event) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * chartWidth;
    const relativeX = Math.min(Math.max(x - padding.left, 0), plotWidth);
    const index = Math.round((relativeX / plotWidth) * Math.max(1, safeData.length - 1));
    setHoveredIndex(Math.min(Math.max(index, 0), safeData.length - 1));
  };

  return (
    <div style={{ position: "relative" }}>
      <BlockStack gap="300">
        <Text as="h3" variant="headingMd">
          {title}
        </Text>
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          role="img"
          aria-label={`${title} chart`}
          style={dashboardChartSvgStyle}
          onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoveredIndex(null)}
        >
          {ticks.map((tick) => {
            const y = padding.top + plotHeight - (tick / maxValue) * plotHeight;
            return (
              <g key={`tick-${tick}`}>
                <line x1={padding.left} x2={chartWidth - padding.right} y1={y} y2={y} stroke="#ebebeb" />
                <text x={padding.left - 26} y={y + 4} fill="#8a8a8a" fontSize="13">
                  {tick}
                </text>
              </g>
            );
          })}
          {labelIndexes.map((index) => (
            <text key={safeData[index]?.date || index} x={points[index]?.x || padding.left} y={chartHeight - 14} fill="#6d7175" fontSize="13" textAnchor="middle">
              {formatChartDate(safeData[index]?.date)}
            </text>
          ))}
          <path d={buildLinePath(previousPoints)} fill="none" stroke="#8bd3f7" strokeWidth="2" strokeLinecap="round" strokeDasharray="4 7" />
          <path d={buildLinePath(points)} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          {activePoint ? (
            <g>
              <line x1={activePoint.x} x2={activePoint.x} y1={padding.top} y2={chartHeight - padding.bottom} stroke="#c9cccf" strokeDasharray="4 4" />
              <circle cx={activePoint.x} cy={activePoint.y} r="5" fill="#ffffff" stroke={color} strokeWidth="2" />
            </g>
          ) : null}
          <rect x={padding.left} y={padding.top} width={plotWidth} height={plotHeight} fill="transparent" />
        </svg>
        <InlineStack align="center" gap="500">
          <InlineStack gap="150" blockAlign="center">
            <span style={{ ...dashboardChartLegendDotStyle, background: color }} />
            <Text as="span" tone="subdued">{formatChartPeriod(safeData)}</Text>
          </InlineStack>
          <InlineStack gap="150" blockAlign="center">
            <span style={{ ...dashboardChartLegendDotStyle, background: "#8bd3f7" }} />
            <Text as="span" tone="subdued">{formatChartPeriod(safePreviousData)}</Text>
          </InlineStack>
        </InlineStack>
      </BlockStack>
      {activePoint && activeData ? (
        <div style={{ ...dashboardChartTooltipStyle, left: tooltipLeft, top: tooltipTop, transform: "translateX(-50%)" }}>
          <BlockStack gap="100">
            <Text as="p" fontWeight="semibold">{formatChartLongDate(activeData.date)}</Text>
            <Text as="p">{`${title}: ${formatInteger(activeData.value)}`}</Text>
            {activePreviousData ? (
              <Text as="p" tone="subdued">{`${formatChartLongDate(activePreviousData.date)}: ${formatInteger(activePreviousData.value)}`}</Text>
            ) : null}
          </BlockStack>
        </div>
      ) : null}
    </div>
  );
}

function normalizeDashboardChartData(data = []) {
  return Array.isArray(data)
    ? data.map((point) => ({
        date: point.date,
        value: Math.max(0, Number(point.value) || 0),
      }))
    : [];
}

function buildDashboardChartPoints(data, maxValue, chartWidth, chartHeight, padding) {
  const plotWidth = chartWidth - padding.left - padding.right;
  const plotHeight = chartHeight - padding.top - padding.bottom;

  return data.map((point, index) => {
    const x = padding.left + index * (plotWidth / Math.max(1, data.length - 1));
    const y = padding.top + plotHeight - (point.value / maxValue) * plotHeight;

    return { x, y };
  });
}

function buildLinePath(points = []) {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
}

function getDashboardChartLabelIndexes(length) {
  if (!length) {
    return [];
  }

  return [0, Math.floor((length - 1) / 4), Math.floor((length - 1) / 2), Math.floor(((length - 1) * 3) / 4), length - 1]
    .filter((index, position, indexes) => indexes.indexOf(index) === position);
}

function parseChartDate(date) {
  const parsed = new Date(`${date}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatChartDate(date) {
  const parsed = parseChartDate(date);
  if (!parsed) {
    return "";
  }

  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(parsed);
}

function formatChartLongDate(date) {
  const parsed = parseChartDate(date);
  if (!parsed) {
    return "";
  }

  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(parsed);
}

function formatChartPeriod(data = []) {
  const first = data[0]?.date;
  const last = data[data.length - 1]?.date;

  if (!first || !last) {
    return "";
  }

  return `${formatChartDate(first)}-${formatChartLongDate(last)}`;
}

function DashboardSparkline({ color, data = [], flat = false }) {
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
      <svg viewBox="0 0 120 56" role="img" aria-label="No change chart" style={dashboardSparklineStyle}>
        <line x1="8" y1="30" x2="112" y2="30" stroke={color} strokeWidth="1" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 120 56" role="img" aria-label="Trend chart" style={dashboardSparklineStyle}>
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

function StatsCard({
  title,
  description,
  actionLabel,
  actionLoading = false,
  onAction,
  stats,
}) {
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">
            {title}
          </Text>

          <Button
            onClick={onAction}
            variant="primary"
            loading={actionLoading}
            disabled={actionLoading}
          >
            {actionLabel}
          </Button>
        </InlineStack>

        <Text as="p" tone="subdued">
          {description}
        </Text>

        <BlockStack gap="0">
          {stats.map((item) => (
            <div key={item.label} style={statsRowStyle}>
              <Link url={item.url} monochrome>
                {item.label}
              </Link>

              <span style={statsValueStyle}>{item.value}</span>
            </div>
          ))}
        </BlockStack>

      </BlockStack>
    </Card>
  );
}

function RecommendedAppsSection() {
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingMd">
          Recommended Our Growth Apps
        </Text>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 10,
            overflowX: "auto",
          }}
        >
          {recommendedApps.map((app) => (
            <div
              key={app.name}
              style={{
                border: "1px solid #e1e3e5",
                padding: 10,
                minHeight: 200,
                minWidth: 220,
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: 5,
                background: "#ffffff",
              }}
            >
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center" gap="300">
                  <img
                    src={app.image}
                    alt=""
                    width="48"
                    height="48"
                    style={{
                      borderRadius: 6,
                      flex: "0 0 auto",
                      objectFit: "cover",
                    }}
                  />
                  <Box
                    background="bg-fill-secondary"
                    paddingBlock="150"
                    paddingInline="300"
                    borderRadius="200"
                  >
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      {app.category}
                    </Text>
                  </Box>
                </InlineStack>

                <Text as="p" fontWeight="semibold">
                  {app.name}
                </Text>

                <Text as="p" tone="subdued">
                  {app.description}
                </Text>
              </BlockStack>

              <div>
                <Button url={app.url} external variant="primary" target="_blank">
                  View app
                </Button>
              </div>
            </div>
          ))}
        </div>
      </BlockStack>
    </Card>
  );
}

function HelpCard() {
  return (
    <Card>
      <InlineStack gap="500" align="space-between" paddingBlockEnd="500" blockAlign="center" wrap>
        <Box width="calc(100% - 180px)">
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Need help?
            </Text>

            <Text as="p">
              We are here for you. For assistance, click support button in the
              corner of your screen. We also provide a comprehensive
              documentation with answers to most common questions.
            </Text>

            <InlineStack gap="300" align="start" wrap>
              <Button url="#" external>
                Contact support
              </Button>

              <Button
                url="#"
                variant="plain"
                external
              >
                View documentation
              </Button>
            </InlineStack>
          </BlockStack>
        </Box>

        <Box
          width="128px"
          minHeight="128px"
          borderRadius="300"
          background="bg-fill-info"
        >
          <div
            aria-hidden="true"
            style={{
              width: 128,
              height: 128,
              borderRadius: 16,
              display: "grid",
              placeItems: "center",
              color: "#fff",
              fontSize: 72,
              lineHeight: 1,
              background:
                "linear-gradient(135deg, #2457ff 0%, #7c3aed 52%, #ff7a59 100%)",
            }}
          >
            ?
          </div>
        </Box>
      </InlineStack>
    </Card>
  );
}

export default function AppIndex() {
  const { overviewStats, taskStats, saleStats } = useLoaderData();
  const shopify = useAppBridge();
  const navigate = useNavigate();
  const location = useLocation();
  const navigation = useNavigation();
  const billingToastShown = useRef(false);
  const nextPath = navigation.location?.pathname;
  const [pendingPath, setPendingPath] = useState("");
  const openingPath = nextPath || pendingPath;

  const openPage = (path) => {
    const target = withShopifyEmbeddedParams(path, location.search);
    setPendingPath(path);
    navigate(target);
  };

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);

    if (
      searchParams.get("billing_status") !== "free_plan_active" ||
      billingToastShown.current
    ) {
      return;
    }

    billingToastShown.current = true;
    shopify.toast.show("Free Plan is active.");
    searchParams.delete("billing_status");
    const nextSearch = searchParams.toString();

    navigate(`${location.pathname}${nextSearch ? `?${nextSearch}` : ""}`, {
      replace: true,
    });
  }, [location.pathname, location.search, navigate, shopify]);

  return (
    <>
      <TitleBar title="Boltr Bulk Price Editor" />

      <Page title="Dashboard">
        <Layout>
          <Layout.Section>
            <Box paddingBlockEnd="00">
              <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
                <MetricCard
                  title="Tasks"
                  value={formatInteger(overviewStats.tasks || 0)}
                  subtitle="items"
                  icon={ProductIcon}
                  color={{ background: "#dff7ee", foreground: "#008060" }}
                  trend={overviewStats.tasksTrend}
                  chart={overviewStats.tasksChart}
                  previousChart={overviewStats.previousTasksChart}
                />
                <MetricCard
                  title="Sales"
                  value={formatInteger(overviewStats.sales || 0)}
                  subtitle="items"
                  icon={DiscountIcon}
                  color={{ background: "#ede9fe", foreground: "#5b21b6" }}
                  trend={overviewStats.salesTrend}
                  chart={overviewStats.salesChart}
                  previousChart={overviewStats.previousSalesChart}
                />
                <MetricCard
                  title="Changes"
                  value={overviewStats.totalChanges}
                  subtitle="items"
                  icon={ChartHistogramGrowthIcon}
                  color={{ background: "#fff7ed", foreground: "#c2410c" }}
                  trend={overviewStats.changesTrend}
                  chart={overviewStats.changesChart}
                  previousChart={overviewStats.previousChangesChart}
                />
                <MetricCard
                  title="Saved time"
                  value={overviewStats.savedTime}
                  icon={ClockIcon}
                  color={{ background: "#dbeafe", foreground: "#1d4ed8" }}
                  trend={overviewStats.savedTimeTrend}
                  chart={overviewStats.savedTimeChart}
                  previousChart={overviewStats.previousSavedTimeChart}
                />
              </InlineGrid>
            </Box>
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <StatsCard
              title="Tasks"
              description="Bulk edit prices in your shop."
              actionLabel="Create task"
              onAction={() => openPage("/app/tasks/new")}
              actionLoading={openingPath === "/app/tasks/new"}
              stats={taskStats}
            />
          </Layout.Section>

          <Layout.Section variant="oneHalf">
            <StatsCard
              title="Sales"
              description="Run manual or scheduled sales."
              actionLabel="Create sale"
              onAction={() => openPage("/app/sales/new")}
              actionLoading={openingPath === "/app/sales/new"}
              stats={saleStats}
            />
          </Layout.Section>

          <Layout.Section>
            <RecommendedAppsSection />
          </Layout.Section>

          <Layout.Section>
            <HelpCard />
          </Layout.Section>
        </Layout>
      </Page>
    </>
  );
}
