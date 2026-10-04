'use strict';

const subscriptionBusy = new Set();
const subscriptionIntervals = { 0: 'Вручную', 1: 'Каждый час', 6: 'Раз в 6 часов', 12: 'Раз в 12 часов', 24: 'Раз в сутки', 72: 'Раз в 3 дня', 168: 'Раз в неделю' };

function serverNoun(count) {
  const n = Math.abs(Number(count)) % 100;
  if (n >= 11 && n <= 14) return 'серверов';
  if (n % 10 === 1) return 'сервер';
  if (n % 10 >= 2 && n % 10 <= 4) return 'сервера';
  return 'серверов';
}

function subscriptionUpdatedLabel(value) {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }) : '';
}

function subscriptionBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
  const unit = value > 0 ? Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1) : 0;
  return (value / 1024 ** unit).toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + ' ' + units[unit];
}

function subscriptionInfoHtml(info = {}) {
  const used = Number.isFinite(info.upload) && Number.isFinite(info.download) ? info.upload + info.download : null;
  const total = Number.isFinite(info.total) ? info.total : null;
  const traffic = used !== null || total !== null;
  const percent = used !== null && total > 0 ? Math.max(0, Math.min(100, used / total * 100)) : null;
  const expiry = info.expire === 0 ? 'Без срока действия' : info.expire > 0 ? new Date(info.expire * 1000).toLocaleDateString('ru-RU') : '';
  if (!traffic && !expiry && !info.title && !info.description) return '';
  return `<div class="subscription-info">
    ${info.title ? `<p class="subscription-provider-title">${escapeHtml(info.title)}</p>` : ''}
    <div class="subscription-details">
      ${traffic ? `<div class="subscription-traffic"><span class="help-text">Трафик</span><div>${used === null ? 'Расход не указан' : subscriptionBytes(used)} / ${total === 0 ? 'Безлимит' : total === null ? 'Лимит не указан' : subscriptionBytes(total)}</div>
        ${percent !== null ? `<div class="subscription-progress" role="progressbar" aria-label="Использовано трафика" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(percent)}"><span style="width:${percent}%"></span></div>` : ''}</div>` : ''}
      ${expiry ? `<div><span class="help-text">${info.expire > 0 && info.expire * 1000 <= Date.now() ? 'Истекла' : 'Срок действия'}</span><div>${expiry}</div></div>` : ''}
    </div>
    ${info.description ? `<p class="subscription-description">${escapeHtml(info.description)}</p>` : ''}
  </div>`;
}

function renderSubscriptions() {
  const list = appData.subscriptions || [];
  document.getElementById('subscriptions-count-badge').textContent = list.length;
  document.getElementById('empty-subscriptions-state').classList.toggle('hidden', list.length > 0);
  const container = document.getElementById('subscriptions-list');
  container.innerHTML = list.map(sub => {
    const busy = subscriptionBusy.has(sub.id);
    const stats = sub.stats;
    const updated = subscriptionUpdatedLabel(sub.lastUpdatedAt);
    const status = busy ? 'Обновляется…' : sub.lastError ? 'Ошибка обновления' : updated ? `Обновлено · ${updated}` : 'Ожидает загрузки';
    return `<article class="glass-card subscription-card">
      <div class="subscription-heading"><h3>${escapeHtml(sub.name)}</h3><span class="subscription-status ${sub.lastError ? 'subscription-error' : ''}">${status}</span></div>
      <p class="subscription-source">${escapeHtml(sub.source)}</p>
      <div class="subscription-metrics"><span><strong>${sub.count || 0}</strong> ${serverNoun(sub.count || 0)}</span><span>${escapeHtml(subscriptionIntervals[sub.intervalHours] || 'Вручную')}</span></div>
      ${subscriptionInfoHtml(sub.info)}
      ${stats?.protected ? `<p class="help-text">Сохранено отсутствующих серверов: ${stats.protected}. Они используются или изменены вручную — проверьте их во вкладке «Подключения».</p>` : ''}
      ${stats?.unsupported?.length ? `<p class="help-text">Пропущены протоколы: ${escapeHtml(stats.unsupported.join(', '))}. Отсутствующие серверы сохранены.</p>` : ''}
      ${sub.lastError ? `<p class="subscription-error" role="alert">${escapeHtml(sub.lastError)}</p>` : ''}
      <div class="subscription-actions">
        <button class="btn btn-primary btn-sm" data-sub-action="refresh" data-sub-id="${escapeHtml(sub.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Загрузка…' : 'Обновить'}</button>
        <button class="btn btn-secondary btn-sm" data-sub-action="edit" data-sub-id="${escapeHtml(sub.id)}" ${busy ? 'disabled' : ''}>Изменить</button>
        <button class="btn btn-danger btn-sm" data-sub-action="delete" data-sub-id="${escapeHtml(sub.id)}" ${busy ? 'disabled' : ''}>Удалить подписку</button>
      </div>
    </article>`;
  }).join('');
}

function openSubscriptionModal(id) {
  const sub = (appData.subscriptions || []).find(x => x.id === id);
  document.getElementById('subscription-form').reset();
  document.getElementById('subscription-id').value = sub?.id || '';
  document.getElementById('subscription-name').value = sub?.name || '';
  document.getElementById('subscription-url').required = !sub;
  document.getElementById('subscription-url-help').textContent = sub ? 'Оставьте поле пустым, чтобы сохранить текущую ссылку. Новая ссылка применяется при следующем обновлении.' : 'Ссылка хранится на роутере и входит в резервную копию.';
  document.getElementById('subscription-interval').value = sub?.intervalHours ?? 24;
  const routing = document.getElementById('subscription-routing');
  routing.innerHTML = appData.routings.map(r => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)}</option>`).join('');
  routing.value = sub?.routingId || appData.connections.find(c => c.id === appData.settings.activeConnectionId)?.routingId || 'routing_all_vpn';
  document.getElementById('subscription-modal-title').textContent = sub ? 'Настройки подписки' : 'Новая подписка';
  document.getElementById('subscription-save').textContent = sub ? 'Сохранить' : 'Добавить и загрузить';
  document.getElementById('subscription-form-error').textContent = '';
  openModal('modal-subscription');
  document.getElementById('subscription-name').focus();
}

async function subscriptionRequest(path, method, body) {
  const response = await fetch('/api/subscriptions' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось выполнить действие');
  return result;
}

async function saveSubscription(event) {
  event.preventDefault();
  const button = document.getElementById('subscription-save');
  if (button.disabled) return;
  const id = document.getElementById('subscription-id').value;
  const body = {
    name: document.getElementById('subscription-name').value.trim(), url: document.getElementById('subscription-url').value.trim(),
    intervalHours: Number(document.getElementById('subscription-interval').value), routingId: document.getElementById('subscription-routing').value
  };
  button.disabled = true;
  button.textContent = id ? 'Сохранение…' : 'Загрузка серверов…';
  document.getElementById('subscription-form-error').textContent = '';
  try {
    const result = await subscriptionRequest(id ? '/' + encodeURIComponent(id) : '', id ? 'PUT' : 'POST', body);
    document.getElementById('subscription-url').value = '';
    closeModal('modal-subscription');
    await loadData();
    switchMainTab('subscriptions');
    showToast(result.error ? 'Подписка сохранена, но загрузка не удалась. Причина указана в карточке.' : id ? 'Настройки сохранены' : 'Подписка загружена', result.error ? 'warning' : 'success');
  } catch (error) { document.getElementById('subscription-form-error').textContent = error.message; }
  finally { button.disabled = false; button.textContent = id ? 'Сохранить' : 'Добавить и загрузить'; }
}

document.getElementById('subscriptions-list').addEventListener('click', async event => {
  const button = event.target.closest('[data-sub-action]');
  if (!button) return;
  const id = button.dataset.subId;
  const action = button.dataset.subAction;
  if (subscriptionBusy.has(id)) return;
  if (action === 'edit') return openSubscriptionModal(id);
  if (action === 'delete' && !confirm('Удалить подписку? Её серверы останутся в списке подключений, автоматическое обновление прекратится.')) return;
  subscriptionBusy.add(id);
  renderSubscriptions();
  try {
    const base = '/' + encodeURIComponent(id);
    await subscriptionRequest(base + (action === 'refresh' ? '/refresh' : ''), action === 'delete' ? 'DELETE' : 'POST');
    showToast(action === 'delete' ? 'Подписка удалена, серверы сохранены' : 'Подписка обновлена', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { subscriptionBusy.delete(id); await loadData(); }
});
