//! One thread that runs the platform's slow calls one at a time, and what
//! happens when one of them never returns.
//!
//! UI Automation talks to other programs; a program that hangs makes the call
//! hang with it. The caller must still get an answer, and the next question
//! must not queue behind a call that will never end. So each task has a
//! deadline, a watchdog answers an overdue task as timed out, and the thread
//! stuck in it is left alone (it cannot be stopped safely) while a new thread
//! takes over the queue. The stuck thread ends by itself when its call does.

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

/// Why a task was answered without running to its end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Abandon {
    Timeout,
    Cancelled,
}

pub struct Task {
    pub id: u64,
    /// Longest the task may run once it has started.
    pub timeout: Duration,
    pub run: Box<dyn FnOnce() + Send>,
    /// Called once, instead of the task's own answer, when it is overdue or cancelled.
    pub abandon: Box<dyn FnOnce(Abandon) + Send>,
}

struct Running {
    id: u64,
    deadline: Instant,
    abandon: Option<Box<dyn FnOnce(Abandon) + Send>>,
}

struct State {
    queue: VecDeque<Task>,
    running: Option<Running>,
    generation: u64,
}

struct Shared {
    state: Mutex<State>,
    work: Condvar,
    dog: Condvar,
    /// Runs first on every worker thread (COM initialisation on Windows).
    init: Box<dyn Fn() + Send + Sync>,
}

fn locked(shared: &Shared) -> MutexGuard<'_, State> {
    match shared.state.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    }
}

pub struct SerialExecutor {
    shared: Arc<Shared>,
}

impl SerialExecutor {
    pub fn new(init: impl Fn() + Send + Sync + 'static) -> SerialExecutor {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                queue: VecDeque::new(),
                running: None,
                generation: 0,
            }),
            work: Condvar::new(),
            dog: Condvar::new(),
            init: Box::new(init),
        });
        spawn_worker(&shared, 0);
        let watched = Arc::clone(&shared);
        thread::Builder::new()
            .name("namzu-win-watchdog".to_owned())
            .spawn(move || watchdog(&watched))
            .expect("start the watchdog thread");
        SerialExecutor { shared }
    }

    pub fn submit(&self, task: Task) {
        let mut st = locked(&self.shared);
        st.queue.push_back(task);
        self.shared.work.notify_one();
    }

    /// Answers task `id` as cancelled if it is waiting or running. A running
    /// task keeps its thread until its call returns; its answer is dropped.
    pub fn cancel(&self, id: u64) {
        let abandon = {
            let mut st = locked(&self.shared);
            if let Some(pos) = st.queue.iter().position(|t| t.id == id) {
                st.queue.remove(pos).map(|t| t.abandon)
            } else {
                st.running
                    .as_mut()
                    .filter(|r| r.id == id)
                    .and_then(|r| r.abandon.take())
            }
        };
        if let Some(abandon) = abandon {
            abandon(Abandon::Cancelled);
        }
    }
}

fn spawn_worker(shared: &Arc<Shared>, generation: u64) {
    let shared = Arc::clone(shared);
    thread::Builder::new()
        .name("namzu-win-worker".to_owned())
        .spawn(move || worker(&shared, generation))
        .expect("start a worker thread");
}

fn worker(shared: &Arc<Shared>, generation: u64) {
    (shared.init)();
    loop {
        let task = {
            let mut st = locked(shared);
            loop {
                if st.generation != generation {
                    return;
                }
                if let Some(task) = st.queue.pop_front() {
                    st.running = Some(Running {
                        id: task.id,
                        deadline: Instant::now() + task.timeout,
                        abandon: Some(task.abandon),
                    });
                    shared.dog.notify_one();
                    break task.run;
                }
                st = match shared.work.wait(st) {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
            }
        };
        // A panic in one task must not take the thread, or the queue, with it.
        let _ = catch_unwind(AssertUnwindSafe(task));
        let mut st = locked(shared);
        if st.generation != generation {
            return;
        }
        st.running = None;
        shared.dog.notify_one();
    }
}

fn watchdog(shared: &Arc<Shared>) {
    let mut st = locked(shared);
    loop {
        let deadline = st.running.as_ref().map(|r| r.deadline);
        match deadline {
            None => {
                st = match shared.dog.wait(st) {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
            }
            Some(deadline) => {
                let now = Instant::now();
                if now < deadline {
                    st = match shared.dog.wait_timeout(st, deadline - now) {
                        Ok((g, _)) => g,
                        Err(p) => p.into_inner().0,
                    };
                    continue;
                }
                let abandon = st.running.take().and_then(|r| r.abandon);
                st.generation += 1;
                let generation = st.generation;
                drop(st);
                spawn_worker(shared, generation);
                if let Some(abandon) = abandon {
                    abandon(Abandon::Timeout);
                }
                st = locked(shared);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn task(
        id: u64,
        timeout: Duration,
        run: impl FnOnce() + Send + 'static,
        abandon: impl FnOnce(Abandon) + Send + 'static,
    ) -> Task {
        Task {
            id,
            timeout,
            run: Box::new(run),
            abandon: Box::new(abandon),
        }
    }

    #[test]
    fn tasks_run_in_order_on_one_thread() {
        let ex = SerialExecutor::new(|| {});
        let (tx, rx) = mpsc::channel();
        for i in 0..5u64 {
            let tx = tx.clone();
            ex.submit(task(
                i,
                Duration::from_secs(60),
                move || {
                    let _ = tx.send((i, thread::current().id()));
                },
                |_| {},
            ));
        }
        let got: Vec<(u64, thread::ThreadId)> = (0..5).map(|_| rx.recv().unwrap()).collect();
        assert_eq!(
            got.iter().map(|g| g.0).collect::<Vec<_>>(),
            vec![0, 1, 2, 3, 4]
        );
        assert!(got.iter().all(|g| g.1 == got[0].1));
    }

    #[test]
    fn the_thread_init_runs_once_per_thread() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let _ex = SerialExecutor::new(move || {
            let _ = tx.lock().unwrap().send(());
        });
        rx.recv().unwrap();
    }

    #[test]
    fn a_task_that_never_returns_times_out_and_the_next_one_runs() {
        let ex = SerialExecutor::new(|| {});
        let (hold_tx, hold_rx) = mpsc::channel::<()>();
        let (out_tx, out_rx) = mpsc::channel();
        let abandoned = out_tx.clone();
        ex.submit(task(
            1,
            Duration::from_millis(20),
            move || {
                // Stuck until the test lets go; ends the thread's call only then.
                let _ = hold_rx.recv();
            },
            move |why| {
                let _ = abandoned.send(format!("abandoned {why:?}"));
            },
        ));
        ex.submit(task(
            2,
            Duration::from_secs(60),
            move || {
                let _ = out_tx.send("second ran".to_owned());
            },
            |_| {},
        ));
        assert_eq!(out_rx.recv().unwrap(), "abandoned Timeout");
        assert_eq!(out_rx.recv().unwrap(), "second ran");
        drop(hold_tx);
    }

    #[test]
    fn a_waiting_task_can_be_cancelled_and_never_runs() {
        let ex = SerialExecutor::new(|| {});
        let (hold_tx, hold_rx) = mpsc::channel::<()>();
        let (started_tx, started_rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel();
        ex.submit(task(
            1,
            Duration::from_secs(60),
            move || {
                let _ = started_tx.send(());
                let _ = hold_rx.recv();
            },
            |_| {},
        ));
        started_rx.recv().unwrap();
        let ran = out_tx.clone();
        let cancelled = out_tx.clone();
        ex.submit(task(
            2,
            Duration::from_secs(60),
            move || {
                let _ = ran.send("ran".to_owned());
            },
            move |why| {
                let _ = cancelled.send(format!("{why:?}"));
            },
        ));
        ex.cancel(2);
        assert_eq!(out_rx.recv().unwrap(), "Cancelled");
        drop(hold_tx);
        ex.submit(task(
            3,
            Duration::from_secs(60),
            move || {
                let _ = out_tx.send("third".to_owned());
            },
            |_| {},
        ));
        assert_eq!(out_rx.recv().unwrap(), "third");
    }

    #[test]
    fn a_panicking_task_does_not_end_the_queue() {
        let ex = SerialExecutor::new(|| {});
        let (tx, rx) = mpsc::channel();
        ex.submit(task(1, Duration::from_secs(60), || panic!("boom"), |_| {}));
        ex.submit(task(
            2,
            Duration::from_secs(60),
            move || {
                let _ = tx.send(());
            },
            |_| {},
        ));
        rx.recv().unwrap();
    }
}
