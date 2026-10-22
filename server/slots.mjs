// Local demo uses China Standard Time and offers one-hour daytime windows.
const offset = '+08:00';
const openingHour = 9;
const closingHour = 19;

export function availableSlots(now = new Date()) {
  const chinaDay = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const base = Date.parse(`${chinaDay}T00:00:00Z`);
  const slots = [];
  for (let day = 0; day < 2; day += 1) {
    const date = new Date(base + day * 86400000).toISOString().slice(0, 10);
    for (let hour = openingHour; hour < closingHour; hour += 1) {
      const start = String(hour).padStart(2, '0');
      const end = String(hour + 1).padStart(2, '0');
      const value = `${date}T${start}:00:00${offset}`;
      if (Date.parse(value) > now.getTime()) slots.push({ value, label: `${day ? '明天' : '今天'} ${start}:00–${end}:00` });
    }
  }
  return slots;
}

export function validSlot(value, now = new Date()) {
  return availableSlots(now).some(slot => slot.value === value);
}
