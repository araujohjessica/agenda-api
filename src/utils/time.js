// Todos os horários da agenda são em horário de Brasília (UTC-3, sem horário de verão).
export const TZ_OFFSET = "-03:00";

export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

export const fromMinutes = (total) =>
  `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;

export const slotInstant = (date, time) => new Date(`${date}T${time}:00${TZ_OFFSET}`);

export const hoursUntil = (date, time) => (slotInstant(date, time).getTime() - Date.now()) / 3_600_000;

export const toISODate = (d) => d.toISOString().slice(0, 10);

// Itera datas "YYYY-MM-DD" de start a end (inclusive) e informa o dia da semana (0=dom ... 6=sáb).
export function* eachDate(start, end) {
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    yield { date: toISODate(cursor), weekday: cursor.getUTCDay() };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
}

export const todayBrasilia = () => new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);
