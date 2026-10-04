'use strict';
// The key is never stored in localStorage or application data. The server issues an HttpOnly session.
(() => {
  const originalFetch=window.fetch.bind(window);
  function showLogin() {
    if(document.getElementById('access-dialog')) return;
    const dialog=document.createElement('dialog');
    dialog.id='access-dialog';
    dialog.style.cssText='max-width:520px;width:calc(100% - 32px);margin:auto;padding:28px;border:1px solid #454563;border-radius:16px;background:#101521;color:#eee';
    dialog.innerHTML='<form id="access-form"><h2>Вход в панель</h2><p>Введите ключ из файла <code>/opt/etc/xkeen-switcher/data/admin-key</code> на роутере. Его можно прочитать через SSH Entware.</p><label for="access-key">Ключ доступа</label><input id="access-key" type="password" required autocomplete="off" style="width:100%;margin:12px 0"><p id="access-error" role="alert"></p><button class="btn btn-primary" type="submit">Войти</button></form>';
    document.body.append(dialog);dialog.showModal();
    dialog.addEventListener('cancel',e=>e.preventDefault());
    document.getElementById('access-key').focus();
    document.getElementById('access-form').addEventListener('submit',async e=>{
      e.preventDefault();const input=document.getElementById('access-key');
      try {const res=await originalFetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:input.value})});input.value='';if(!res.ok) throw Error((await res.json()).error||'Вход не выполнен.');location.reload();}
      catch(error){document.getElementById('access-error').textContent=error.message;}
    });
  }
  document.getElementById('access-logout')?.addEventListener('click',async()=>{const result=await originalFetch('/api/auth/logout',{method:'POST'});if(result.ok||result.status===401) location.reload();});
  window.fetch=async (...args)=>{const response=await originalFetch(...args);if(response.status===401) showLogin();return response;};
})();
