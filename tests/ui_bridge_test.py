"""Browser tests that need the bridge: a temporary server.js (free port; database, projects and repository register in a temporary
folder) with two git repositories made here. Covers the first start (database created from the example), repository registration in
the Nova operação wizard, an operation on the team map, registration in Configurações and the Painel's REPOSITÓRIOS block.
No claude run is started. Needs node, git, Playwright + Chromium (CHROMIUM_EXECUTABLE). Results: <SQUAD_PREVIEW_DIR or previews/>.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json, traceback, os, shutil, sys, socket, subprocess, tempfile, time, urllib.request, stat
ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.environ.get('SQUAD_PREVIEW_DIR',str(ROOT/'previews')))
OUT.mkdir(parents=True,exist_ok=True)
results=[]

def test(name, condition=True):
    assert condition, name
    results.append({'name':name,'passed':True})
    print('PASS',name,flush=True)

def git(cwd,*args): subprocess.run(['git','-c','user.name=SQUAD test','-c','user.email=test@squad.local',*args],cwd=cwd,check=True,capture_output=True)
def free_port():
    with socket.socket() as s: s.bind(('127.0.0.1',0));return s.getsockname()[1]
def rm_tree(path): # git marks its objects read-only on Windows
    shutil.rmtree(path,onerror=lambda f,p,e:(os.chmod(p,stat.S_IWRITE),f(p)))
def click(page,action,root='#modalRoot'): page.locator(f'{root} [data-action="{action}"]').first.click()
def until(page,js,what): # waits, and says what the screen showed when it does not get there
    try: page.wait_for_function(js,timeout=15000)
    except Exception: raise AssertionError(f"{what}: toasts={page.locator('#toastRoot').inner_text()[-300:]!r}")
def repo_cards(page): return page.evaluate("[...document.querySelectorAll('.home-repo')].map(c=>({name:c.querySelector('h3').textContent,strips:[...c.querySelectorAll('.home-next')].map(n=>n.dataset.tone+':'+n.querySelector('strong').textContent),ops:c.querySelector('.home-repo-ops').textContent,primary:c.querySelector('.home-project-foot .btn.primary').textContent}))")

if not shutil.which('git') or not shutil.which('node'):
    print('SKIP: git and node are needed for the bridge tests');sys.exit(0)
tmp=Path(tempfile.mkdtemp(prefix='squad-ui-bridge-'))
server=None
try:
    # Repository A: a team map (docs/squad) on main and an apps/api subfolder. Repository B: a clone of A whose base branch is gone.
    a=tmp/'repo-a';(a/'docs'/'squad').mkdir(parents=True);(a/'apps'/'api').mkdir(parents=True)
    (a/'README.md').write_text('hi\n');(a/'docs'/'squad'/'mapa.md').write_text('# mapa\n');(a/'apps'/'api'/'main.txt').write_text('api\n')
    git(a,'init','-q','-b','main');git(a,'add','-A');git(a,'commit','-qm','init')
    git(tmp,'clone','-q',str(a),'repo-b')
    (tmp/'repos.json').write_text('{"repos":[]}')
    port=free_port();url=f'http://127.0.0.1:{port}/'
    env={**os.environ,'SQUAD_DATA_DIR':str(tmp/'data'),'SQUAD_PROJECTS_DIR':str(tmp/'projects'),'SQUAD_REPOS':str(tmp/'repos.json'),'SQUAD_CLAUDE_BIN':str(tmp/'no-claude')}
    server=subprocess.Popen(['node','server.js','--port',str(port)],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    for _ in range(100):
        try: urllib.request.urlopen(url,timeout=1);break
        except Exception: time.sleep(0.1)
    with sync_playwright() as pw:
        binary=os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium')
        browser=pw.chromium.launch(executable_path=binary,headless=True)
        context=browser.new_context(viewport={'width':1400,'height':1000},reduced_motion='reduce');context.set_default_timeout(30000)
        page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        try:
            page.goto(url);page.wait_for_function("ui.bridge.checked")
            test('First start asks how to create the database',page.evaluate("ui.modal")=='db-setup' and not (tmp/'data'/'squad.db').exists())
            click(page,'db-setup-demo');page.wait_for_function("diskSync.on&&!ui.modal")
            test('Carregar exemplo creates the database',(tmp/'data'/'squad.db').exists() and page.evaluate("state.projects.length")==1)
            page.evaluate("state.settings.mapQuality='low';render()")

            # Nova operação: register the repository inside the code step.
            click(page,'project-new','#homeView');page.locator('#opNewName').fill('Op no Repo A');page.locator('button[form=opNewForm]').click()
            test('With the bridge and no repository, the existing repository option is enabled',not page.locator('[name=kind][value=existing]').is_disabled())
            page.locator('#opNewRemote').fill('https://github.com/x/y.git')
            page.locator('[name=kind][value=existing]').check()
            page.locator('#opNewRepoName').press('Enter')
            test('Registering without a source is refused in place','Informe a pasta' in page.locator('#opNewRepoErr').inner_text())
            page.locator('#opNewRepoSource').fill(str(tmp/'nao-existe'));click(page,'op-new-repo-save');page.wait_for_function("!document.getElementById('opNewRepoErr').hidden&&!/Informe/.test(document.getElementById('opNewRepoErr').textContent)")
            test('A bridge refusal is shown in the step and keeps the form',page.locator('#opNewRepoSource').is_visible() and page.locator('#opNewRepoErr').inner_text()!='')
            page.locator('#opNewRepoSource').fill(str(a))
            test('Name and identifier are suggested from the source',page.get_attribute('#opNewRepoName','placeholder')=='repo-a' and page.evaluate("document.getElementById('opNewRepoKey').placeholder")=='repo-a')
            page.locator('#opNewRepoName').fill('Repo A');page.locator('#opNewRepoSource').press('Enter');page.wait_for_selector('#opNewRepo')
            test('Enter registers the repository and selects it',page.evaluate("document.getElementById('opNewRepo').value")=='repo-a' and page.locator('[name=kind][value=existing]').is_checked())
            test('The remote typed before is kept',page.evaluate("document.getElementById('opNewRemote').value")=='https://github.com/x/y.git')
            click(page,'op-new-repo-add');page.locator('#opNewRepoSource').fill(str(a/'apps'/'api'))
            test('A second source gets a unique identifier',page.evaluate("document.getElementById('opNewRepoKey').placeholder")=='api')
            page.locator('#opNewRepoSource').fill(str(a));page.wait_for_timeout(50)
            test('An identifier already taken gets a suffix',page.evaluate("document.getElementById('opNewRepoKey').placeholder")=='repo-a-2')
            click(page,'op-new-repo-cancel')
            test('Escolher um cadastrado goes back to the list',page.evaluate("document.getElementById('opNewRepo').value")=='repo-a')
            page.wait_for_function("document.querySelector('[name=reconMode][value=team]')")
            test('The team map is offered and preselected',page.evaluate("document.querySelector('[name=reconMode]:checked').value")=='team')
            page.locator('button[form=opNewCodeForm]').click();click(page,'op-new-existing');page.locator('button[form=opNewSquadForm]').click()
            page.wait_for_function("project().name==='Op no Repo A'")
            test('The operation is created on the repository with the team map',page.evaluate("[project().repoId,project().reconMode]")==['repo-a','team'])

            # Configurações > Repositórios, reached from the Painel.
            page.evaluate("goView('home')");click(page,'home-repo-add','#homeView')
            page.locator('#repoKey').fill('repo-b');page.locator('#repoName').fill('Repo B');page.locator('#repoSource').fill(str(tmp/'repo-b'));page.locator('#repoBranch').fill('release/9')
            page.wait_for_function("!!ui.repoList")
            test('What is typed before the repository list arrives is kept',page.evaluate("[repoKey.value,repoName.value,repoBranch.value]")==['repo-b','Repo B','release/9'])
            page.locator('#repoForm [type=submit]').click();until(page,"(ui.bridge.repos?.repos||[]).some(r=>r.id==='repo-b')",'repo-b registered')
            test('Configurações registers a repository',json.loads((tmp/'repos.json').read_text())['repos'][-1]['id']=='repo-b')
            page.locator('#modalRoot [data-action=modal-close]').first.click()

            # The Painel's REPOSITÓRIOS block.
            page.evaluate("goView('home')");page.wait_for_function("ui.teamMaps?.['repo-a']?.at&&ui.baseChecks?.['repo-b']?.at")
            page.evaluate("render()")
            cards=repo_cards(page);ra=next(c for c in cards if c['name']=='Repo A');rb=next(c for c in cards if c['name']=='Repo B')
            test('Repo A shows its team map and the operation on it',ra['strips']==['ready:Mapa da equipe na base'] and 'OP-002' in ra['ops'] and ra['primary'].endswith('Nova operação aqui'))
            test('Repo B shows only the gone base branch and offers to change it',rb['strips']==['warn:Branch base fora do origin'] and rb['primary'].endswith('Trocar branch base'))
            page.locator(".home-repo:has(h3:text-is('Repo A')) [data-action=home-repo-op]").click()
            page.locator('#opNewName').fill('Segunda no Repo A');page.locator('button[form=opNewForm]').click()
            test('Nova operação aqui opens the code step on that repository',page.locator('[name=kind][value=existing]').is_checked() and page.evaluate("document.getElementById('opNewRepo').value")=='repo-a')
            page.locator('#modalRoot [data-action=modal-close]').first.click()
            page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(200)
            test('Phone width: no horizontal scroll on the Painel',page.evaluate("document.querySelector('#homeView').scrollWidth<=document.querySelector('#homeView').clientWidth"))
            page.locator('.home-repos').scroll_into_view_if_needed();page.screenshot(path=str(OUT/'squad-code-network-bridge-repos.png'))
            test('No uncaught browser errors',not errors)
        except Exception as exc:
            try: page.screenshot(path=str(OUT/'squad-code-network-bridge-failure.png'))
            except Exception: pass
            results.append({'name':'failure','passed':False,'error':str(exc)})
            traceback.print_exc()
        finally:
            browser.close()
finally:
    if server: server.terminate();server.wait(timeout=10)
    passed=sum(r['passed'] for r in results);failed=sum(not r['passed'] for r in results)
    (OUT/'ui-bridge-results.json').write_text(json.dumps({'tests':results,'passed':passed,'failed':failed},indent=2))
    print('PASSED',passed,'FAILED',failed)
    rm_tree(tmp)

if not results or any(not item['passed'] for item in results):
    sys.exit(1)
