import { Controller, Get, Logger, Module, Query } from '@nestjs/common';
import { Public } from './auth';

/*
 * Подсказки городов при регистрации и в настройках.
 * Если задан DADATA_API_KEY — ищем по всей России через DaData (любой населённый пункт),
 * иначе — по встроенному списку городов. Город всегда можно вписать вручную.
 */

const CITIES = [
  'Москва', 'Санкт-Петербург', 'Новосибирск', 'Екатеринбург', 'Казань', 'Нижний Новгород', 'Красноярск', 'Челябинск',
  'Самара', 'Уфа', 'Ростов-на-Дону', 'Краснодар', 'Омск', 'Воронеж', 'Пермь', 'Волгоград', 'Саратов', 'Тюмень',
  'Тольятти', 'Махачкала', 'Барнаул', 'Ижевск', 'Хабаровск', 'Ульяновск', 'Иркутск', 'Владивосток', 'Ярославль',
  'Севастополь', 'Томск', 'Ставрополь', 'Кемерово', 'Набережные Челны', 'Оренбург', 'Новокузнецк', 'Балашиха',
  'Рязань', 'Чебоксары', 'Калининград', 'Пенза', 'Липецк', 'Киров', 'Астрахань', 'Тула', 'Улан-Удэ', 'Сургут',
  'Курск', 'Симферополь', 'Магнитогорск', 'Якутск', 'Тверь', 'Брянск', 'Иваново', 'Белгород', 'Сочи', 'Владимир',
  'Нижний Тагил', 'Архангельск', 'Чита', 'Калуга', 'Курган', 'Смоленск', 'Волжский', 'Череповец', 'Орёл', 'Вологда',
  'Саранск', 'Мурманск', 'Владикавказ', 'Якутск', 'Грозный', 'Подольск', 'Тамбов', 'Стерлитамак', 'Петрозаводск',
  'Кострома', 'Нижневартовск', 'Новороссийск', 'Йошкар-Ола', 'Химки', 'Таганрог', 'Комсомольск-на-Амуре', 'Сыктывкар',
  'Нальчик', 'Шахты', 'Дзержинск', 'Братск', 'Орск', 'Ангарск', 'Энгельс', 'Благовещенск', 'Королёв', 'Великий Новгород',
  'Старый Оскол', 'Мытищи', 'Псков', 'Люберцы', 'Южно-Сахалинск', 'Бийск', 'Прокопьевск', 'Армавир', 'Балаково',
  'Абакан', 'Норильск', 'Сызрань', 'Красногорск', 'Петропавловск-Камчатский', 'Каменск-Уральский', 'Златоуст',
  'Электросталь', 'Миасс', 'Альметьевск', 'Рыбинск', 'Салават', 'Копейск', 'Пятигорск', 'Находка', 'Хасавюрт',
  'Майкоп', 'Нефтекамск', 'Березники', 'Коломна', 'Одинцово', 'Домодедово', 'Ковров', 'Нефтеюганск', 'Новочеркасск',
  'Кисловодск', 'Серпухов', 'Новый Уренгой', 'Ноябрьск', 'Елец', 'Бердск', 'Обнинск', 'Новомосковск', 'Магадан',
  'Ханты-Мансийск', 'Горно-Алтайск', 'Кызыл', 'Элиста', 'Биробиджан', 'Анадырь', 'Нарьян-Мар', 'Салехард',
];
const UNIQUE = [...new Set(CITIES)];
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();

export async function suggestCities(q: string): Promise<string[]> {
  const query = q.trim();
  const key = process.env.DADATA_API_KEY;
  if (key && query.length >= 2) {
    try {
      const r = await fetch('https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Token ${key}` },
        body: JSON.stringify({ query, count: 10, from_bound: { value: 'city' }, to_bound: { value: 'settlement' } }),
        signal: AbortSignal.timeout(3000),
      });
      if (r.ok) {
        const body: any = await r.json();
        const names = (body.suggestions ?? []).map((s: any) => s.data?.city ?? s.data?.settlement ?? s.value).filter(Boolean);
        if (names.length) return [...new Set<string>(names)];
      }
    } catch (e: any) {
      Logger.warn(`DaData недоступна: ${e.message}`, 'Города');
    }
  }
  const n = norm(query);
  if (!n) return UNIQUE.slice(0, 15);
  const starts = UNIQUE.filter((c) => norm(c).startsWith(n));
  const contains = UNIQUE.filter((c) => !norm(c).startsWith(n) && norm(c).includes(n));
  return [...starts, ...contains].slice(0, 15);
}

@Controller('public/cities')
export class CitiesController {
  @Public()
  @Get()
  list(@Query('q') q = '') {
    return suggestCities(String(q).slice(0, 60));
  }
}

@Module({ controllers: [CitiesController] })
export class CitiesModule {}
