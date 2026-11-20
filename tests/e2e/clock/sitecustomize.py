"""The end-to-end run's clock (JP-188). Python 3.9, standard library only.

`scripts/e2e.py` puts this folder on PYTHONPATH for every process of a sandbox laptop, so Python loads it at start. When
JOSH360_E2E_CLOCK names a file, every Python clock that reads the wall time (time.time, time.gmtime, time.localtime,
time.strftime, time.ctime and datetime.datetime's now, utcnow and today) runs that many seconds ahead of the real one. The
driver moves the clock forward between job passes, so the laptop's five-minute passes and the runner's waits happen in
seconds. Monotonic clocks are untouched, so subprocess timeouts and sleeps stay real. Without the variable, or with a
file that cannot be read, nothing changes. Nothing outside the end-to-end harness sets the variable.
"""
import os

_FILE = os.environ.get("JOSH360_E2E_CLOCK")

if _FILE:
    import datetime as _dt
    import time as _time

    _real_time = _time.time
    _real_gmtime, _real_localtime, _real_strftime, _real_ctime = (_time.gmtime, _time.localtime, _time.strftime,
                                                                   _time.ctime)

    def _offset() -> float:
        try:
            with open(_FILE, encoding="utf-8") as handle:
                return float(handle.read().strip() or 0)
        except (OSError, ValueError):
            return 0.0

    def time() -> float:  # noqa: D103
        return _real_time() + _offset()

    def gmtime(secs=None):  # noqa: D103
        return _real_gmtime(time() if secs is None else secs)

    def localtime(secs=None):  # noqa: D103
        return _real_localtime(time() if secs is None else secs)

    def strftime(fmt, t=None):  # noqa: D103
        return _real_strftime(fmt, localtime() if t is None else t)

    def ctime(secs=None):  # noqa: D103
        return _real_ctime(time() if secs is None else secs)

    _time.time, _time.gmtime, _time.localtime, _time.strftime, _time.ctime = time, gmtime, localtime, strftime, ctime

    class _DateTime(_dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return cls.fromtimestamp(time(), tz)

        @classmethod
        def utcnow(cls):
            return cls.utcfromtimestamp(time())

        @classmethod
        def today(cls):
            return cls.fromtimestamp(time())

    _dt.datetime = _DateTime        # date.today() is left real: a date subclass would break isinstance(x, date)
