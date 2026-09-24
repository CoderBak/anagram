"""Native registration tests use only temporary homes and an in-memory registry."""
import importlib.util
import json
import os
import shlex
import shutil
import signal
import time
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1] / 'installer/native_registration.py'
spec = importlib.util.spec_from_file_location('native_registration', SOURCE)
reg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reg)
ID = 'abcdefghijklmnopabcdefghijklmnop'


class FakeRegistry:
    def __init__(self): self.values = {}; self.fail = None
    def read(self, browser, view): return self.values.get((browser, view))
    def write(self, browser, view, value):
        if self.fail == (browser, view):
            self.fail = None
            raise OSError('injected registry error')
        if value is None: self.values.pop((browser, view), None)
        else: self.values[(browser, view)] = value


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.user = Path(self.temp.name).resolve() / 'user'
        self.home = self.user / 'component with spaces'
        for p in ('app', 'bin', 'run'): (self.home / p).mkdir(parents=True, exist_ok=True)
        (self.home / '.anagram-home').write_text('owned')
        (self.home / 'app/native_host.py').write_text('# fixture')
        (self.home / 'bin/anagram-native.exe').write_bytes(b'fixture')
        self.registry = FakeRegistry()

    def register(self, browser='chrome', extension=ID, platform='linux', language='en'):
        return reg.register(self.home, browser, extension, language, user_home=self.user,
                            platform=platform, registry=self.registry)

    def unregister(self, platform='linux'):
        return reg.unregister(self.home, user_home=self.user, platform=platform, registry=self.registry)

    def test_exact_chrome_origin_and_private_launcher(self):
        e = self.register()
        d = json.loads(Path(e['manifest']).read_text())
        self.assertEqual(d['allowed_origins'], ['chrome-extension://' + ID + '/'])
        self.assertEqual(d['path'], str(self.home / 'bin/anagram-native'))
        script = Path(d['path']).read_text()
        self.assertIn(' -I -u ', script)
        self.assertNotIn('python3 ', script)
        if os.name != 'nt': self.assertEqual(Path(e['manifest']).stat().st_mode & 0o777, 0o600)
        marker = json.loads((self.home / reg.OWNER).read_text())
        self.assertEqual(marker['home'], str(self.home))

    def test_mac_firefox_and_chrome_paths(self):
        first = self.register(platform='darwin')
        second = self.register('firefox', reg.FIREFOX_ID, 'darwin', 'zh_CN')
        self.assertIn('Library/Application Support/Google/Chrome/', Path(first['manifest']).as_posix())
        self.assertIn('Library/Application Support/Mozilla/', Path(second['manifest']).as_posix())
        self.assertEqual(json.loads(Path(second['manifest']).read_text())['allowed_extensions'], [reg.FIREFOX_ID])
        self.unregister('darwin')
        self.assertFalse(Path(first['manifest']).exists())
        self.assertFalse(Path(second['manifest']).exists())

    def test_invalid_origin_and_language_refused_without_writes(self):
        for browser, extension, language in [('chrome','*','en'),('chrome','a'*31,'en'),('chrome','z'*32,'en'),('firefox','foreign@example.org','en'),('chrome',ID,'xx')]:
            with self.assertRaises(ValueError): self.register(browser,extension,language=language)
        self.assertFalse((self.home / reg.INVENTORY).exists())

    def test_foreign_manifest_not_overwritten(self):
        path = reg.manifest_path(self.home,self.user,'chrome','linux')
        path.parent.mkdir(parents=True); path.write_text('foreign')
        with self.assertRaisesRegex(ValueError,'different'): self.register()
        self.assertEqual(path.read_text(),'foreign')

    @unittest.skipIf(os.name == 'nt', 'POSIX registration lock')
    def test_two_homes_racing_for_one_browser_leave_one_owner(self):
        other = self.user / 'second home'
        for p in ('app', 'bin', 'run'): (other / p).mkdir(parents=True)
        (other / '.anagram-home').write_text('owned'); (other / 'app/native_host.py').write_text('# fixture')
        write, both_checked = reg.atomic_write, threading.Barrier(2, timeout=1)
        def racing(path, value, mode=0o600):
            if path.name == reg.HOST + '.json':
                try: both_checked.wait()  # the first writer waits until the other home has checked as well
                except threading.BrokenBarrierError: pass
            return write(path, value, mode)
        results = {}
        def register(home):
            try: results[home] = reg.register(home, 'chrome', ID, 'en', user_home=self.user, platform='linux')
            except ValueError as exc: results[home] = exc
        with patch.object(reg, 'atomic_write', side_effect=racing):
            threads = [threading.Thread(target=register, args=(home,)) for home in (self.home, other)]
            for thread in threads: thread.start()
            for thread in threads: thread.join(15)
        owners = [home for home, result in results.items() if isinstance(result, dict)]
        self.assertEqual(len(owners), 1, results)
        loser, = {self.home, other} - set(owners)
        self.assertRegex(str(results[loser]), 'different')
        reg.unregister(owners[0], user_home=self.user, platform='linux')
        self.assertFalse(reg.manifest_path(owners[0], self.user, 'chrome', 'linux').exists())

    @unittest.skipIf(os.name == 'nt', 'unprivileged Windows symlinks vary by policy')
    def test_registration_parent_symlink_refused(self):
        outside = self.user / 'outside'; outside.mkdir()
        (self.user / '.config').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'link'): self.register()
        self.assertEqual(list(outside.iterdir()),[])

    def test_modified_registration_is_not_deleted(self):
        e = self.register(); path = Path(e['manifest']); path.write_text('another owner')
        with self.assertRaisesRegex(ValueError,'modified'): self.unregister()
        self.assertEqual(path.read_text(),'another owner')
        self.assertTrue((self.home / reg.INVENTORY).exists())

    def test_inventory_cannot_redirect_cleanup(self):
        self.register(); path = self.home / reg.INVENTORY
        value = json.loads(path.read_text()); victim = self.user / 'victim'; victim.write_text('keep')
        value['registrations'][0]['manifest'] = str(victim); path.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError,'unexpected'): self.unregister()
        self.assertEqual(victim.read_text(),'keep')

    def test_windows_exact_hkcu_views_and_unregistration(self):
        e = self.register(platform='win32')
        self.assertEqual(self.registry.values,{('chrome',32):e['manifest'],('chrome',64):e['manifest']})
        self.assertIn('Software\\Google\\Chrome\\NativeMessagingHosts\\',reg.registry_key('chrome'))
        self.unregister('win32')
        self.assertEqual(self.registry.values,{})
        self.assertFalse(Path(e['manifest']).exists())

    def test_failed_windows_registration_rolls_back(self):
        self.registry.fail = ('chrome',64)
        with self.assertRaises(OSError): self.register(platform='win32')
        self.assertEqual(self.registry.values,{})
        self.assertFalse(reg.manifest_path(self.home,self.user,'chrome','win32').exists())
        self.assertFalse((self.home / reg.INVENTORY).exists())

    def test_foreign_registry_owner_preserved(self):
        self.registry.values[('chrome',32)] = 'C:\\foreign.json'
        with self.assertRaisesRegex(ValueError,'different'): self.register(platform='win32')
        self.assertEqual(self.registry.values[('chrome',32)],'C:\\foreign.json')

    def test_failed_windows_unregistration_restores_owned_keys(self):
        entry=self.register(platform='win32')
        before=dict(self.registry.values)
        self.registry.fail=('chrome',64)
        with self.assertRaises(OSError): self.unregister('win32')
        self.assertEqual(self.registry.values,before)
        self.assertTrue(Path(entry['manifest']).exists())

    def test_readonly_inventory_owner_mismatch(self):
        self.register(); marker=self.home/reg.OWNER
        d=json.loads(marker.read_text());d['home']=str(self.user);marker.write_text(json.dumps(d))
        with self.assertRaisesRegex(ValueError,'ownership'): self.unregister()

    def test_missing_inventory_preserves_home_and_registration(self):
        entry = self.register(platform=sys.platform)
        manifest = Path(entry['manifest'])
        before = manifest.read_bytes()
        (self.home / reg.INVENTORY).unlink()
        with patch.object(reg.Path, 'home', return_value=self.user):
            for operation in (reg.unregister, reg.update, reg.uninstall):
                with self.subTest(operation=operation.__name__):
                    with self.assertRaisesRegex(ValueError, 'inventory is missing'):
                        operation(self.home)
                    self.assertEqual(manifest.read_bytes(), before)
                    self.assertTrue((self.home / reg.OWNER).is_file())
                    self.assertTrue((self.home / 'app/native_host.py').is_file())

    def test_windows_worker_receives_a_fixed_update_plan_without_spawning(self):
        self.register(platform='win32', language='zh_CN')
        installer = self.home / 'app/install.ps1'
        installer.write_text('# inert audit fixture')
        with patch.object(reg.Path, 'home', return_value=self.user), patch.object(reg.sys, 'platform', 'win32'), \
                patch.object(reg, 'maintenance_lock') as lock, patch.object(reg.subprocess, 'run') as run:
            lock.return_value.__enter__.return_value = None
            plan = reg.update(self.home, worker=True)
        self.assertEqual(plan, {'status':'prepared', 'installer':str(installer), 'browser':'chrome',
                               'extension_id':ID, 'language':'zh_CN'})
        run.assert_not_called()

    def test_windows_update_hands_the_pinned_release_to_the_worker(self):
        self.register(platform='win32')
        (self.home / 'app/maintenance.ps1').write_text('# inert audit fixture')
        job = self.user / 'job'; job.mkdir()
        with patch.object(reg.Path, 'home', return_value=self.user), patch.object(reg.sys, 'platform', 'win32'), \
                patch.dict(os.environ, {'SystemRoot': str(self.user)}), patch.object(reg, 'subprocess') as process, \
                patch.object(reg.tempfile, 'mkdtemp', return_value=str(job)):
            reg.update(self.home, release='0.6.1')
            reg.update(self.home)
        pinned, latest = [call.args[0] for call in process.Popen.call_args_list]
        self.assertEqual(pinned[pinned.index('-Release') + 1], '0.6.1')
        self.assertNotIn('-Release', latest)

    @unittest.skipIf(os.name == 'nt', 'Windows uses the detached maintenance worker')
    def test_uninstall_removes_only_owned_home_and_manifest(self):
        self.register(platform=sys.platform)
        victim=self.user/'keep';victim.write_text('keep')
        with patch.object(reg.Path,'home',return_value=self.user): reg.uninstall(self.home)
        self.assertFalse(self.home.exists());self.assertEqual(victim.read_text(),'keep')

    @unittest.skipIf(os.name == 'nt', 'unprivileged Windows symlinks vary by policy')
    def test_uninstall_never_follows_nested_file_or_directory_links(self):
        self.register(platform=sys.platform)
        outside=self.user/'outside';outside.mkdir();(outside/'keep').write_text('keep')
        (self.home/'nested').symlink_to(outside,target_is_directory=True)
        with patch.object(reg.Path,'home',return_value=self.user): reg.uninstall(self.home)
        self.assertEqual((outside/'keep').read_text(),'keep')


@unittest.skipIf(os.name != "posix", "POSIX inherited flock chain; Windows uses the fixed job worker")
class MaintenanceLockTests(unittest.TestCase):
    register = RegistrationTests.register

    def setUp(self):
        RegistrationTests.setUp(self)
        sys.path.insert(0, str(SOURCE.parents[1] / "anagramd"))
        from native_component import HomeLock, ComponentError
        self.HomeLock, self.ComponentError = HomeLock, ComponentError
        self.register(platform=sys.platform)

    def test_inherited_descriptor_is_validated_and_never_unlocked_by_helper(self):
        lock = self.HomeLock(self.home)
        try:
            fd = lock.maintenance_fd()
            with reg.maintenance_lock(self.home, fd) as borrowed:
                self.assertEqual(borrowed, fd)
            with self.assertRaises(self.ComponentError): self.HomeLock(self.home)
            other = os.open(self.home / "other", os.O_RDWR | os.O_CREAT, 0o600)
            try:
                with self.assertRaisesRegex(ValueError, "not the owned"):
                    with reg.maintenance_lock(self.home, other): pass
            finally: os.close(other)
        finally: lock.close()
        self.HomeLock(self.home).close()

    def test_uninstall_revokes_startup_marker_before_tree_deletion(self):
        remove = reg.shutil.rmtree
        def checked(path):
            self.assertFalse((self.home / reg.OWNER).exists())
            with self.assertRaises(self.ComponentError): self.HomeLock(self.home)
            return remove(path)
        with patch.object(reg.Path, "home", return_value=self.user), patch.object(reg.shutil, "rmtree", side_effect=checked):
            reg.uninstall(self.home)
        self.assertFalse(self.home.exists())

    def test_interrupted_uninstall_is_finished_by_the_terminal_command(self):
        command = self.home / 'bin/anagram'
        shutil.copyfile(SOURCE.parent / 'anagram', command); command.chmod(0o700)
        (self.home / 'models/editlens').mkdir(parents=True); (self.home / 'models/editlens/weights').write_bytes(b'x')
        (self.home / 'venv/bin').mkdir(parents=True)
        manifest = reg.manifest_path(self.home, self.user, 'chrome', sys.platform)
        remove = reg.shutil.rmtree
        def closed_terminal(path, *args, **kwargs):
            if Path(path).name == 'models': raise KeyboardInterrupt
            return remove(path, *args, **kwargs)
        with patch.object(reg.Path, 'home', return_value=self.user), patch.object(reg.shutil, 'rmtree', side_effect=closed_terminal):
            with self.assertRaises(KeyboardInterrupt): reg.uninstall(self.home)
        self.assertFalse(manifest.exists())
        self.assertFalse((self.home / reg.OWNER).exists())
        with self.assertRaises(self.ComponentError): self.HomeLock(self.home)
        for name in ('.anagram-home', reg.UNINSTALLING, 'bin/anagram', 'models/editlens/weights'):
            self.assertTrue((self.home / name).exists(), name)
        env = {k: v for k, v in os.environ.items() if k != 'ANAGRAM_HOME'}
        run = subprocess.run([str(command), 'uninstall', '-y'], env={**env, 'HOME': str(self.user)},
                             stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertFalse(self.home.exists())

    def test_shell_retains_child_acquired_flock_after_python_exits(self):
        # The direct installer can use the existing private Python to flock an FD
        # opened by its parent shell. The lock must outlive that short-lived Python.
        acquire = """
import fcntl, os, pathlib, stat, sys
actual = os.fstat(9)
expected = (pathlib.Path(sys.argv[1]) / '.native-host.lock').lstat()
assert stat.S_ISREG(actual.st_mode) and stat.S_ISREG(expected.st_mode)
assert (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino)
fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
"""
        script = 'set -eu\nexec 9<>"$1/.native-host.lock"\n"$2" -I -c "$3" "$1"\nprintf "locked\\n"\nread -r release\n'
        process = subprocess.Popen(['/bin/sh', '-c', script, 'installer-lock-test', str(self.home), sys.executable, acquire],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline(), 'locked\n')
            with self.assertRaises(self.ComponentError): self.HomeLock(self.home)
            process.communicate('release\n', timeout=3)
            self.assertEqual(process.returncode, 0)
            self.HomeLock(self.home).close()
        finally:
            if process.poll() is None: process.kill()
            process.communicate(timeout=3)

    def test_update_passes_only_verified_descriptor_to_installer(self):
        lock = self.HomeLock(self.home)
        try:
            fd = lock.maintenance_fd()
            with patch.object(reg.Path, 'home', return_value=self.user), patch.object(reg.subprocess, 'run') as run:
                reg.update(self.home, lock_fd=fd)
            kwargs = run.call_args.kwargs
            self.assertEqual(kwargs['env']['ANAGRAM_MAINTENANCE_FD'], str(fd))
            self.assertEqual(kwargs['pass_fds'], (fd,))
            with self.assertRaises(self.ComponentError): self.HomeLock(self.home)
        finally:
            lock.close()

    def test_update_pins_only_a_strict_release_version(self):
        lock = self.HomeLock(self.home)
        try:
            fd = lock.maintenance_fd()
            with patch.object(reg.Path, 'home', return_value=self.user), patch.object(reg.subprocess, 'run') as run, \
                    patch.dict(os.environ, {'ANAGRAM_RELEASE_URL': 'https://example.com/elsewhere'}):
                reg.update(self.home, lock_fd=fd)
                self.assertNotIn('ANAGRAM_RELEASE_URL', run.call_args.kwargs['env'])
                reg.update(self.home, lock_fd=fd, release='0.6.1')
                self.assertEqual(run.call_args.kwargs['env']['ANAGRAM_RELEASE_URL'],
                                 'https://github.com/CoderBak/anagram/releases/download/v0.6.1')
                run.reset_mock()
                for release in ('v0.6.1', '0.6', '0.6.1-rc.1', '01.6.1', '0.6.1\n', '\u0660.\u0666.\u0661', '0.6.1/../x', 6):
                    with self.subTest(release=release), self.assertRaisesRegex(ValueError, 'MAJOR.MINOR.PATCH'):
                        reg.update(self.home, lock_fd=fd, release=release)
                run.assert_not_called()
        finally:
            lock.close()

    def test_installer_grandchild_keeps_lock_after_owner_and_helper_are_killed(self):
        # Exercise real Python -> helper -> /bin/sh -> fake installer, with no
        # network, browser registrations outside this temporary user, or models.
        child = """
import os, pathlib, sys, time
home=pathlib.Path(sys.argv[1])
(home/"installer.pid").write_text(str(os.getpid()))
deadline=time.monotonic()+10
while not (home/"finish").exists():
    if time.monotonic()>deadline: raise SystemExit(2)
    time.sleep(.01)
(home/"installer-finished").write_text("done")
"""
        (self.home / "app/install.sh").write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + " -c " + shlex.quote(child) + ' "$ANAGRAM_HOME"\n')
        owner = """
import pathlib, subprocess, sys, time
sys.path.insert(0, sys.argv[1])
from native_component import HomeLock
home=pathlib.Path(sys.argv[2]); lock=HomeLock(home); fd=lock.maintenance_fd()
helper=subprocess.Popen([sys.executable,"-I",sys.argv[3],"update","--lock-fd",str(fd),"--home",str(home)],pass_fds=(fd,),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
(home/"helper.pid").write_text(str(helper.pid))
time.sleep(15)
"""
        process = subprocess.Popen([sys.executable, "-c", owner, str(SOURCE.parents[1] / "anagramd"), str(self.home), str(SOURCE)],
                                   env={**os.environ,"HOME":str(self.user)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        descendants = []
        try:
            deadline = time.monotonic() + 5
            while not (self.home / "installer.pid").exists() and time.monotonic() < deadline:
                self.assertIsNone(process.poll()); time.sleep(.01)
            self.assertTrue((self.home / "installer.pid").exists())
            helper = int((self.home / "helper.pid").read_text())
            installer = int((self.home / "installer.pid").read_text())
            descendants = [helper, installer]
            process.kill(); process.wait(timeout=2)
            with self.assertRaises(self.ComponentError): self.HomeLock(self.home)
            os.kill(helper, signal.SIGKILL)
            with self.assertRaises(self.ComponentError): self.HomeLock(self.home)
            (self.home / "finish").write_text("finish")
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                try:
                    lock = self.HomeLock(self.home)
                    lock.close()
                    break
                except self.ComponentError: time.sleep(.01)
            else: self.fail("lock remained held after the installer finished")
            self.assertTrue((self.home / "installer-finished").exists())
        finally:
            if process.poll() is None: process.kill()
            process.wait(timeout=2)
            for pid in descendants:
                try: os.kill(pid, signal.SIGTERM)
                except ProcessLookupError: pass


if __name__ == '__main__': unittest.main()
