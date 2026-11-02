import { useSearchParams } from 'react-router-dom';
import { useMe } from '../App';
import { SupportForm } from '../components/SupportForm';

/** Техподдержка в кабинете: бесплатное подключение интеграций, проблемы, вопросы о тарифе. */
export function Support() {
  const { me } = useMe();
  const [p] = useSearchParams();
  const topic = (p.get('topic') ?? undefined) as 'integration' | 'problem' | 'plan' | 'other' | undefined;
  return <>
    <section className="panel">
      <h2>Техподдержка</h2>
      <p className="note">Не получается подключить магазин, 1С или CRM? Подключение <b>бесплатное</b> — опишите подробно, что и куда передавать, и отметьте, какие доступы вы готовы дать. Инженер ответит на почту в течение одного рабочего дня. Данные вашей компании прикрепятся к обращению сами.</p>
      <ol className="steps">
        <li>Опишите систему, которую подключаем, и что должно происходить: например, «оплаченные заказы из InSales создаются в Маршруте, статус “Доставлен” возвращается в магазин».</li>
        <li>Подготовьте доступы: отдельную учётную запись администратора, API-ключ или контакт программиста. Пароли в форму не вписывайте — инженер попросит их отдельно.</li>
        <li>Если подключение идёт из «Интеграций», ключ Маршрута инженер выпустит вместе с вами.</li>
      </ol>
    </section>
    <section className="panel">
      <SupportForm defaults={{ topic, plan: p.get('plan') ?? undefined, name: me.user.name }} />
    </section>
  </>;
}
