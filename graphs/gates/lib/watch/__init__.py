"""The validation watch (JP-165 to JP-169): when a watch begins and ends, how its check log is graded, the log itself,
and one call of the wait step. Python 3.9, standard library only. Pure parts first (`timetable`, `grading`), then the
files (`log`, `round`). Nothing here uses a model, and nothing here writes outside the run's own `work/watch/` folder."""
