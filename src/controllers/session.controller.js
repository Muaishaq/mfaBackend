const crypto = require('crypto');
const prisma = require('../config/db');
const asyncHandler = require('../utils/asyncHandler');

// Generate a unique Jitsi room name
const generateRoomName = (academy) => {
  const short = crypto.randomUUID().split('-')[0];
  return `mfa-${academy}-${short}`;
};

// @desc    Get all upcoming sessions for enrolled student
// @route   GET /api/sessions
// @access  Private (student)
const getSessions = asyncHandler(async (req, res) => {
  // Get student's active enrollments
  const enrollments = await prisma.enrollment.findMany({
    where: {
      student_id: req.user.id,
      status: 'active'
    },
    select: {
      course_id: true,
      batch_id: true
    }
  });

  const courseIds = enrollments.map(e => e.course_id).filter(Boolean);
  const batchIds = enrollments.map(e => e.batch_id).filter(Boolean);

  const sessions = await prisma.liveSession.findMany({
    where: {
      OR: [
        { course_id: { in: courseIds } },
        { batch_id: { in: batchIds } }
      ],
      scheduled_at: { gte: new Date() }
    },
    include: {
      course: { select: { title: true, academy: true } },
      batch: { select: { name: true } }
    },
    orderBy: { scheduled_at: 'asc' }
  });

  res.json({
    success: true,
    message: 'Sessions retrieved successfully',
    data: { sessions }
  });
});

// @desc    Get all sessions (admin)
// @route   GET /api/sessions/all
// @access  Admin
const getAllSessions = asyncHandler(async (req, res) => {
  const sessions = await prisma.liveSession.findMany({
    include: {
      course: { 
        select: { title: true, academy: true },
        include: {
          enrollments: {
            where: { status: 'active' },
            include: {
              student: { select: { full_name: true, email: true } }
            }
          }
        }
      },
      batch: { 
        select: { name: true },
        include: {
          enrollments: {
            where: { status: 'active' },
            include: {
              student: { select: { full_name: true, email: true } }
            }
          }
        }
      }
    },
    orderBy: { scheduled_at: 'desc' }
  });

  // Format sessions to include enrolled students
  const sessionsWithEnrollments = sessions.map(session => {
    const enrolledStudents = [];
    
    if (session.course?.enrollments) {
      session.course.enrollments.forEach(e => {
        enrolledStudents.push({
          name: e.student.full_name,
          email: e.student.email,
          type: 'course'
        });
      });
    }
    
    if (session.batch?.enrollments) {
      session.batch.enrollments.forEach(e => {
        enrolledStudents.push({
          name: e.student.full_name,
          email: e.student.email,
          type: 'batch'
        });
      });
    }

    return {
      ...session,
      enrolledStudents
    };
  });

  res.json({
    success: true,
    message: 'All sessions retrieved',
    data: { sessions: sessionsWithEnrollments }
  });
});

// @desc    Get single session
// @route   GET /api/sessions/:id
// @access  Private
const getSession = asyncHandler(async (req, res) => {
  const session = await prisma.liveSession.findUnique({
    where: { id: req.params.id },
    include: {
      course: { select: { title: true, academy: true } },
      batch: { select: { name: true } }
    }
  });

  if (!session) {
    return res.status(404).json({
      success: false,
      message: 'Session not found'
    });
  }

  // Generate Jitsi URL
  const jitsiUrl = `https://meet.jit.si/${session.jitsi_room}`;

  // Check if session is joinable (within 15 minutes of start or currently live)
  const now = new Date();
  const sessionStart = new Date(session.scheduled_at);
  const sessionEnd = new Date(sessionStart.getTime() + session.duration_mins * 60000);
  const fifteenMinsBefore = new Date(sessionStart.getTime() - 15 * 60000);

  const isJoinable = now >= fifteenMinsBefore && now <= sessionEnd;
  const isLive = now >= sessionStart && now <= sessionEnd;
  const isEnded = now > sessionEnd;

  res.json({
    success: true,
    message: 'Session retrieved successfully',
    data: {
      session,
      jitsiUrl,
      isJoinable,
      isLive,
      isEnded
    }
  });
});

// @desc    Create a live session
// @route   POST /api/sessions
// @access  Admin
const createSession = asyncHandler(async (req, res) => {
  const { title, course_id, batch_id, scheduled_at, duration_mins } = req.body;

  if (!title || !scheduled_at) {
    return res.status(400).json({
      success: false,
      message: 'Please provide title and scheduled date'
    });
  }

  // Determine academy for room name
  let academy = 'forex';
  if (course_id) {
    const course = await prisma.course.findUnique({
      where: { id: course_id },
      select: { academy: true }
    });
    if (course) academy = course.academy;
  } else if (batch_id) {
    const batch = await prisma.batch.findUnique({
      where: { id: batch_id },
      select: { academy: true }
    });
    if (batch) academy = batch.academy;
  }

  const jitsi_room = generateRoomName(academy);

  const session = await prisma.liveSession.create({
    data: {
      title,
      course_id,
      batch_id,
      scheduled_at: new Date(scheduled_at),
      duration_mins: duration_mins || 60,
      jitsi_room,
      created_by: req.user.id
    }
  });

  // Notify enrolled students
  let studentIds = [];

  if (course_id) {
    const enrollments = await prisma.enrollment.findMany({
      where: { course_id, status: 'active' },
      select: { student_id: true }
    });
    studentIds = enrollments.map(e => e.student_id);
  } else if (batch_id) {
    const enrollments = await prisma.enrollment.findMany({
      where: { batch_id, status: 'active' },
      select: { student_id: true }
    });
    studentIds = enrollments.map(e => e.student_id);
  }

  if (studentIds.length > 0) {
    await prisma.notification.createMany({
      data: studentIds.map(student_id => ({
        user_id: student_id,
        title: '📹 New Live Class Scheduled',
        message: `"${title}" has been scheduled for ${new Date(scheduled_at).toLocaleString()}`
      }))
    });
  }

  res.status(201).json({
    success: true,
    message: 'Session created successfully',
    data: {
      session,
      jitsiUrl: `https://meet.jit.si/${jitsi_room}`
    }
  });
});

// @desc    Update a session
// @route   PUT /api/sessions/:id
// @access  Admin
const updateSession = asyncHandler(async (req, res) => {
  const session = await prisma.liveSession.findUnique({
    where: { id: req.params.id }
  });

  if (!session) {
    return res.status(404).json({
      success: false,
      message: 'Session not found'
    });
  }

  const updated = await prisma.liveSession.update({
    where: { id: req.params.id },
    data: req.body
  });

  res.json({
    success: true,
    message: 'Session updated successfully',
    data: { session: updated }
  });
});

// @desc    Delete a session
// @route   DELETE /api/sessions/:id
// @access  Admin
const deleteSession = asyncHandler(async (req, res) => {
  await prisma.liveSession.delete({
    where: { id: req.params.id }
  });

  res.json({
    success: true,
    message: 'Session deleted successfully',
    data: {}
  });
});

// @desc    Add recording URL after class
// @route   PATCH /api/sessions/:id/recording
// @access  Admin
const addRecording = asyncHandler(async (req, res) => {
  const { recording_url } = req.body;

  if (!recording_url) {
    return res.status(400).json({
      success: false,
      message: 'Please provide a recording URL'
    });
  }

  const updated = await prisma.liveSession.update({
    where: { id: req.params.id },
    data: { recording_url }
  });

  res.json({
    success: true,
    message: 'Recording URL added successfully',
    data: { session: updated }
  });
});

module.exports = {
  getSessions,
  getAllSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  addRecording
};