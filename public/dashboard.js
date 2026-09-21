const projectGrid = document.getElementById('project-grid');
const newProjectBtn = document.getElementById('new-project-btn');
const zipInput = document.getElementById('zip-input');
const importStatus = document.getElementById('import-status');
const dashboardMain = document.querySelector('.dashboard');

function timeAgo(iso) {
  if (!iso) return 'sem data';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'agora mesmo';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `há ${days} d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `há ${months} mês(es)`;
  return `há ${Math.floor(months / 12)} ano(s)`;
}

function setImportStatus(text, kind) {
  if (!text) {
    importStatus.classList.add('hidden');
    importStatus.textContent = '';
    return;
  }
  importStatus.textContent = text;
  importStatus.className = 'import-status' + (kind ? ' ' + kind : '');
}

async function fetchProjects() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    renderProjects(data.projects || []);
  } catch (err) {
    projectGrid.innerHTML = '<p class="dashboard-empty">Não foi possível carregar os projetos.</p>';
  }
}

function renderProjects(projects) {
  projectGrid.innerHTML = '';
  if (projects.length === 0) {
    projectGrid.innerHTML =
      '<p class="dashboard-empty">Nenhum projeto ainda. Crie um novo ou importe um .zip para começar.</p>';
    return;
  }
  for (const project of projects) {
    projectGrid.appendChild(buildProjectCard(project));
  }
}

function buildProjectCard(project) {
  const card = document.createElement('div');
  card.className = 'project-card';

  const icon = document.createElement('div');
  icon.className = 'project-card-icon';
  icon.textContent = '📄';

  const body = document.createElement('div');
  body.className = 'project-card-body';

  const name = document.createElement('div');
  name.className = 'project-card-name';
  name.textContent = project.name;

  const meta = document.createElement('div');
  meta.className = 'project-card-meta';
  meta.textContent = `Editado ${timeAgo(project.updatedAt)}`;

  body.appendChild(name);
  body.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'project-card-actions';

  const renameBtn = document.createElement('span');
  renameBtn.className = 'tree-action';
  renameBtn.textContent = '✎';
  renameBtn.title = 'Renomear projeto';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    renameProject(project);
  });

  const deleteBtn = document.createElement('span');
  deleteBtn.className = 'tree-action';
  deleteBtn.textContent = '✕';
  deleteBtn.title = 'Excluir projeto';
  deleteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteProject(project);
  });

  actions.appendChild(renameBtn);
  actions.appendChild(deleteBtn);

  card.appendChild(icon);
  card.appendChild(body);
  card.appendChild(actions);

  card.addEventListener('click', () => {
    window.location.href = `editor.html?id=${encodeURIComponent(project.id)}`;
  });

  return card;
}

async function renameProject(project) {
  const newName = prompt('Novo nome do projeto:', project.name);
  if (!newName || newName === project.name) return;
  try {
    await fetch(`/api/projects/${encodeURIComponent(project.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
  } finally {
    fetchProjects();
  }
}

async function deleteProject(project) {
  if (!confirm(`Excluir o projeto "${project.name}"? Essa ação não pode ser desfeita.`)) return;
  try {
    await fetch(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
  } finally {
    fetchProjects();
  }
}

newProjectBtn.addEventListener('click', async () => {
  const name = prompt('Nome do novo projeto:', 'Documento sem título');
  if (!name) return;
  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.success) {
      window.location.href = `editor.html?id=${encodeURIComponent(data.id)}`;
    } else {
      alert('Falha ao criar projeto: ' + (data.error || 'erro desconhecido'));
    }
  } catch (err) {
    alert('Falha ao criar projeto: ' + err.message);
  }
});

async function importZip(file) {
  if (!file) return;
  setImportStatus(`Importando "${file.name}"…`);
  const formData = new FormData();
  formData.append('zip', file);
  try {
    const res = await fetch('/api/projects/import', { method: 'POST', body: formData });
    const data = await res.json();
    if (!data.success) {
      setImportStatus('Falha ao importar: ' + (data.error || 'erro desconhecido'), 'error');
      return;
    }
    if (data.warning) {
      setImportStatus(data.warning, 'warning');
      await fetchProjects();
      setTimeout(() => {
        window.location.href = `editor.html?id=${encodeURIComponent(data.id)}`;
      }, 2500);
    } else {
      window.location.href = `editor.html?id=${encodeURIComponent(data.id)}`;
    }
  } catch (err) {
    setImportStatus('Falha ao importar: ' + err.message, 'error');
  }
}

zipInput.addEventListener('change', () => {
  importZip(zipInput.files[0]);
  zipInput.value = '';
});

dashboardMain.addEventListener('dragover', (e) => {
  e.preventDefault();
  dashboardMain.classList.add('drag-over');
});
dashboardMain.addEventListener('dragleave', () => {
  dashboardMain.classList.remove('drag-over');
});
dashboardMain.addEventListener('drop', (e) => {
  e.preventDefault();
  dashboardMain.classList.remove('drag-over');
  const file = Array.from(e.dataTransfer.files).find((f) => f.name.toLowerCase().endsWith('.zip'));
  if (file) importZip(file);
});

fetchProjects();
