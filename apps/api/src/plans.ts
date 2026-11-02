/**
 * Тарифных пакетов и подписок нет: платформа зарабатывает процент с каждого заказа (PLATFORM_FEE_PERCENT).
 * Поле companies.plan оставлено для совместимости (панель владельца, заявки в поддержку).
 */
export const PLANS = [{ id: 'start', name: 'Базовый' }, { id: 'business', name: 'Базовый' }, { id: 'white_label', name: 'Корпоративный' }] as const;
export type PlanId = (typeof PLANS)[number]['id'];
export const PLAN_IDS = PLANS.map((p) => p.id) as [PlanId, ...PlanId[]];
